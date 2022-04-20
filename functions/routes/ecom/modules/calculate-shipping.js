const axios = require('axios')
const ecomUtils = require('@ecomplus/utils')

exports.post = ({ appSdk }, req, res) => {
  /**
   * Treat `params` and (optionally) `application` from request body to properly mount the `response`.
   * JSON Schema reference for Calculate Shipping module objects:
   * `params`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
   * `response`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
   *
   * Examples in published apps:
   * https://github.com/ecomplus/app-mandabem/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-datafrete/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-jadlog/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   */

  const { params, application } = req.body
  const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)
  const { quoting_mode } = appData
  const token = appData.intelipost_token

  if (!token) {
    // must have configured Intelipost token
    return res.status(409).send({
      error: 'CALCULATE_AUTH_ERR',
      message: `Token unset on app hidden data (merchant must configure token on the app) on ${storeId}`
    })
  }

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }

  const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''
  const checkZipCode = rule => {
    // validate rule zip range
    if (destinationZip && rule.zip_range) {
      const { min, max } = rule.zip_range
      return Boolean((!min || destinationZip >= min) && (!max || destinationZip <= max))
    }
    return true
  }

  let originZip, warehouseCode
  if (params.from) {
    originZip = params.from.zip
  } else if (Array.isArray(appData.warehouses) && appData.warehouses.length) {
    for (let i = 0; i < appData.warehouses.length; i++) {
      const warehouse = appData.warehouses[i]
      if (warehouse && warehouse.zip && checkZipCode(warehouse)) {
        const { code } = warehouse
        if (!code) {
          continue
        }
        if (
          params.items &&
          params.items.find(({ quantity, inventory }) => inventory && Object.keys(inventory).length && !(inventory[code] >= quantity))
        ) {
          // item not available on current warehouse
          continue
        }
        originZip = warehouse.zip
        if (warehouse.intelipost_doc) {
          docNumber = warehouse.intelipost_doc
        }
        warehouseCode = code
      }
    }
  }
  if (!originZip) {
    originZip = appData.zip
  }
  originZip = typeof originZip === 'string' ? originZip.replace(/\D/g, '') : ''


  // search for configured free shipping rule
  if (Array.isArray(appData.free_shipping_rules)) {
    for (let i = 0; i < appData.free_shipping_rules.length; i++) {
      const rule = appData.free_shipping_rules[i]
      if (rule && checkZipCode(rule)) {
        if (!rule.min_amount) {
          response.free_shipping_from_value = 0
          break
        } else if (!(response.free_shipping_from_value <= rule.min_amount)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }
  }

  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }

  /* DO THE STUFF HERE TO FILL RESPONSE OBJECT WITH SHIPPING SERVICES */

  if (!originZip) {
    // must have configured origin zip code to continue
    return res.status(409).send({
      error: 'CALCULATE_SKIP',
      message: `Zip code is unset on app hidden data (merchant must configure the app) on ${storeId}`
    })
  }

  if (params.items) {
    // send POST request to Datafrete REST API
    const headers = {
      'api-key': token
    }
    return axios.post(
      'https://api.intelipost.com.br/api/v1/quote_by_product',
      {
        origin_zip_code: originZip,
        destination_zip_code: destinationZip,
        quoting_mode: quoting_mode,

        products: params.items.map(item => {
          const { sku, name, quantity, dimensions, weight } = item
          // parse cart items to Datafrete schema
          let kgWeight = 0
          if (weight && weight.value) {
            switch (weight.unit) {
              case 'g':
                kgWeight = weight.value / 1000
                break
              case 'mg':
                kgWeight = weight.value / 1000000
                break
              default:
                kgWeight = weight.value
            }
          }
          const cmDimensions = {}
          if (dimensions) {
            for (const side in dimensions) {
              const dimension = dimensions[side]
              if (dimension && dimension.value) {
                switch (dimension.unit) {
                  case 'm':
                    cmDimensions[side] = dimension.value * 100
                    break
                  case 'mm':
                    cmDimensions[side] = dimension.value / 10
                    break
                  default:
                    cmDimensions[side] = dimension.value
                }
              }
            }
          }
          return {
            quantity,
            sku_id: sku,
            height: cmDimensions.height || 0,
            width: cmDimensions.width || 0,
            length: cmDimensions.length || 0,
            weight: kgWeight,
            cost_of_goods: ecomUtils.price(item)
          }
        })
      },
      { 
        headers
      }
    )

      .then(({ data, status }) => {
        console.log('Resultado', data)
        let result
        if (typeof data === 'string') {
          try {
            result = JSON.parse(data)
          } catch (e) {
            console.log('> Intelipost invalid JSON response')
            return res.status(409).send({
              error: 'CALCULATE_INVALID_RES',
              message: data
            })
          }
        } else {
          result = data
        }

        if (result && result.status === 1 && Array.isArray(result.data && result.data.delivery_options)) {
          // success response
          const { delivery_options } = result.data
          delivery_options.forEach(intelipostService => {
            // parse to E-Com Plus shipping line object
            const serviceCode = String(intelipostService.delivery_method_id)
            const price = parseFloat(
              intelipostService.final_shipping_cost >= 0 && intelipostService.final_shipping_cost !== null
                ? intelipostService.final_shipping_cost
                : intelipostService.provider_shipping_cost
            )

            // push shipping service object to response
            response.shipping_services.push({
              label: intelipostService.delivery_method_name || intelipostService.description,
              carrier: intelipostService.delivery_method_name,
              carrier_doc_number: typeof intelipostService.cnpj_transportador === 'string'
                ? intelipostService.cnpj_transportador.replace(/\D/g, '').substr(0, 19)
                : undefined,
              service_name: `${intelipostService.logistic_provider_name} (Intelipost)`,
              service_code: serviceCode,
              shipping_line: {
                from: {
                  ...params.from,
                  zip: originZip
                },
                to: params.to,
                price,
                total_price: price,
                discount: 0,
                delivery_time: {
                  days: parseInt(intelipostService.delivery_estimate_business_days, 10),
                  working_days: true
                },
                posting_deadline: {
                  days: 3,
                  ...appData.posting_deadline
                },
                warehouse_code: warehouseCode,
                flags: ['intelipost-ws', `intelipost-${serviceCode}`.substr(0, 20)],
                app
              }
            })
          })
          res.send(response)
        } else {
          // console.log(data)
          const err = new Error('Invalid Intelipost calculate response')
          err.response = { data, status }
          throw err
        }
      })

      .catch(err => {
        let { message, response } = err
        if (response && response.data) {
          // try to handle Intelipost error response
          const { data } = response
          let result
          if (typeof data === 'string') {
            try {
              result = JSON.parse(data)
            } catch (e) {
            }
          } else {
            result = data
          }
          console.log('> Intelipost invalid result:', data)
          if (result && result.data) {
            // Intelipost error message
            return res.status(409).send({
              error: 'CALCULATE_FAILED',
              message: result.data
            })
          }
          message = `${message} (${response.status})`
        } else {
          console.error(err)
        }
        return res.status(409).send({
          error: 'CALCULATE_ERR',
          message
        })
      })
  } else {
    res.status(400).send({
      error: 'CALCULATE_EMPTY_CART',
      message: 'Cannot calculate shipping without cart items'
    })
  }

  res.send(response)
}
