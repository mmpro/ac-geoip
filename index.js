const _ = require('lodash')
const ipPackage = require('ip')
const fs = require('fs')

const WebServiceClient = require('@maxmind/geoip2-node').WebServiceClient;
const Reader = require('@maxmind/geoip2-node').Reader;

const acgeoip = () => {
  
  let geoip = {
    userId: 'userId',
    licenseKey: 'licenseKey',
    environment: 'development',
    // redis, // instance of redis
    // reader // initiated if useBuffer with local database
    geolite: {
      useBuffer: false,
      enabled: false,
      path: '/path/to/GeoLite2-City.mmdb'
    },
    cacheTime: 7 * 86400, // cache GEOIP response for 1 week
    mapping: [
      { response: 'iso2', geoIP: 'country.isoCode' },
      { response: 'city', geoIP: 'city.names.en' },
      { response: 'region', geoIP: 'subdivisions[0].names.en' },
      { response: 'isp', geoIP: 'traits.isp' },
      { response: 'organization', geoIP: 'traits.organization' },
      { response: 'domain', geoIP: 'traits.domain' },
      { response: 'latitude', geoIP: 'location.latitude' },
      { response: 'longitude', geoIP: 'location.longitude' }
    ]
  }

  const init = (params) => {
    if (_.has(params, 'userId')) _.set(geoip, 'userId', _.get(params, 'userId'))
    if (_.has(params, 'licenseKey')) _.set(geoip, 'licenseKey', _.get(params, 'licenseKey'))
    if (_.has(params, 'env')) _.set(geoip, 'environment', _.get(params, 'env'))
    if (_.has(params, 'redis')) _.set(geoip, 'redis', _.get(params, 'redis'))
    if (_.has(params, 'geolite')) _.set(geoip, 'geolite', _.get(params, 'geolite'))

    if (_.get(params, 'geolite.enabled') && _.get(params, 'geolite.useBuffer')) {
      const dbBuffer = fs.readFileSync(_.get(geoip, 'geolite.path'))
      geoip.reader = Reader.openBuffer(dbBuffer)
    }
  }



  const lookupLocal = async(params, cb) => {
    if (!_.get(geoip, 'geolite.enabled')) {
      let message = 'acgeoip_geolite_notEnabled'
      if (_.isFunction(cb)) return cb({ message })
      throw Error(message)
    }
    const ip = _.get(params, 'ip')
    if (ipPackage.isPrivate(ip)) {
      if (_.isFunction(cb)) return cb()
      return
    }

    const mapping = _.get(params, 'mapping', geoip.mapping)
    const debug = _.get(params, 'debug')

    let response = {
      ip
    }
    let geoipResponse

    geoipResponse = await checkRedis(params)

    if (!geoipResponse) {
      if (_.get(geoip, 'geolite.useBuffer') && geoip.reader) {
        geoipResponse = geoip.reader.city(ip)
      }
      else {
        try {
          if (_.get(geoip, 'geolite.enabled')) {
            geoipResponse = await new Promise((resolve, reject) => {
                Reader.open(_.get(geoip, 'geolite.path')).then(reader => {
                const response = reader.city(ip)
                resolve(response)
              }).catch(reject)
            })
          }

          if (debug) {
            console.log('AC-GEOIP | From Geolite | %s', JSON.stringify(geoipResponse, null, 2))
          }
        }
        catch(e) {
          console.error('AC-GEOIP | From Geolite | Failed | %j', e)
        }
      }
      if (geoipResponse) {
        _.set(geoipResponse, 'origin', 'db')
        await storeRedis({ ip, geoipResponse })  
      }
    }

    // prepare response
    if (!_.isEmpty(mapping)) {
      _.forEach(mapping, item => {
        if (_.get(geoipResponse, item.geoIP)) _.set(response, item.response, _.get(geoipResponse, item.geoIP))
      })
    }
    else {
      response = geoipResponse
    }
    _.set(response, 'origin', _.get(geoipResponse, 'origin'))
    if (_.get(geoipResponse, 'fromCache')) _.set(response, 'fromCache', true)

    if (_.isFunction(cb)) return cb(null, response)
    return response
  }

  const lookup = async(params, cb) => {
    if (!_.get(geoip, 'licenseKey') || _.get(geoip, 'licenseKey') === 'licenseKey') {
      let message = 'acgeoip_licenseKey_missing'
      if (_.isFunction(cb)) return cb({ message })
      throw Error(message)
    }
    const ip = _.get(params, 'ip')
    if (ipPackage.isPrivate(ip)) {
      if (_.isFunction(cb)) return cb()
      return
    }

    const mapping = _.get(params, 'mapping', geoip.mapping)
    const debug = _.get(params, 'debug')

    let response = {
      ip
    }
    let geoipResponse

    geoipResponse = await checkRedis(params)
    // fetch fresh
    if (!_.get(geoipResponse, 'country')) {
      try {
        const client = new WebServiceClient(geoip.userId, geoip.licenseKey)
        geoipResponse = await new Promise((resolve, reject) => {
            client.city(ip).then(result => {
              return resolve(result)
          }).catch(reject)
        })

        if (debug) {
          console.log('AC-GEOIP | From Maxmind | %s', JSON.stringify(geoipResponse, null, 2))
        }
      }
      catch(e) {
        console.error('AC-GEOIP | From Maxmind | Failed | %j', e)
      }
    }

    if (geoipResponse) {
      await storeRedis({ ip, geoipResponse })  
    }

    // prepare response
    if (!_.isEmpty(mapping)) {
      _.forEach(mapping, item => {
        if (_.get(geoipResponse, item.geoIP)) _.set(response, item.response, _.get(geoipResponse, item.geoIP))
      })
    }
    else {
      response = geoipResponse
    }

    _.set(geoipResponse, 'origin', 'webservice')
    if (_.get(geoipResponse, 'fromCache')) _.set(response, 'fromCache', true)

    if (_.isFunction(cb)) return cb(null, response)
    return response
  }

  const checkRedis = async(params, cb) => {
    const refresh = _.get(params, 'refresh')
    if (!geoip.redis || refresh) {
      if (_.isFunction(cb)) return cb()
      return
    }
    const ip = _.get(params, 'ip')
    const redisKey = _.get(geoip, 'environment') + ':geoip:' + ip
    const debug = _.get(params, 'debug')

    let geoipResponse
    try {
      geoipResponse = await geoip.redis.get(redisKey)
      geoipResponse = JSON.parse(geoipResponse)
      if (_.isPlainObject(geoipResponse)) {
        geoipResponse.fromCache = true
      }
      if (debug) {
        console.log('AC-GEOIP | From Cache | %j', JSON.stringify(geoipResponse, null, 2))
      }
    }
    catch(e) {
      console.log(e)
      console.error('AC-GEOIP | From Cache | Failed | %j', e)
    }
    return geoipResponse
  }

  const storeRedis = async(params) => {
    const refresh = _.get(params, 'refresh')
    if (!geoip.redis || refresh) {
      return
    }
    const ip = _.get(params, 'ip')
    const geoipResponse = _.get(params, 'geoipResponse')
    const redisKey = _.get(geoip, 'environment') + ':geoip:' + ip

    await geoip.redis.setex(redisKey, geoip.cacheTime, JSON.stringify(geoipResponse))
  }


  return {
    init,
    lookup,
    lookupLocal
  }
}

module.exports = acgeoip()


