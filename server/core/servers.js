const fs = require('fs-extra')
const http = require('http')
const https = require('https')
const { ApolloServer } = require('apollo-server-express')
const Promise = require('bluebird')
const _ = require('lodash')
const jobcontrol = require('../helpers/job-control')

/* global WIKI */

function listenServer(config, server) {
  if (typeof config.port === 'string') {
    if (config.port.startsWith('fd:')) {
      const fd = parseInt(config.port.slice("fd:".length))
      server.listen({fd: fd})
      return
    } else if (config.port.startsWith('unix:')) {
      const socketPath = config.port.slice('unix:'.length)
      server.listen({path: socketPath})
      return
    }
  }
  server.listen(config.port, config.bindIP)
}

const updateStatus = () => {
  jobcontrol.setJobStatus(`Serving requests... ${module.exports.connections.size} active requests, ${module.exports.connectionsCompleted} completed requests`)
}

const ratelimitFunctionCall = (minDelayBetweenCalls, func) => {
  let nextCallAllowed = -Infinity
  let callPending = false

  const callFunc = () => {
    nextCallAllowed = _.now() + minDelayBetweenCalls
    callPending = false
    func()
  }

  return () => {
    if (callPending) return
    const now = _.now()
    if (now >= nextCallAllowed) {
      callFunc()
    } else {
      callPending = true
      _.delay(callFunc, nextCallAllowed - now)
    }
  }
}

const ratelimitedUpdateStatus = ratelimitFunctionCall(1000, updateStatus)

module.exports = {
  servers: {
    graph: null,
    http: null,
    https: null
  },
  listenCalled: {
    http: false,
    https: false,
  },
  connections: new Map(),
  connectionsCompleted: 0,
  le: null,
  /**
   * Start HTTP Server
   */
  async startHTTP () {
    WIKI.logger.info(`HTTP Server on port: [ ${WIKI.config.port} ]`)
    this.servers.http = http.createServer(WIKI.app)
    this.servers.graph.installSubscriptionHandlers(this.servers.http)

    this.servers.http.on('error', (error) => {
      if (error.syscall !== 'listen') {
        throw error
      }

      switch (error.code) {
        case 'EACCES':
          WIKI.logger.error('Listening on port ' + WIKI.config.port + ' requires elevated privileges!')
          return process.exit(1)
        case 'EADDRINUSE':
          WIKI.logger.error('Port ' + WIKI.config.port + ' is already in use!')
          return process.exit(1)
        default:
          throw error
      }
    })

    this.servers.http.on('listening', () => {
      WIKI.logger.info('HTTP Server: [ RUNNING ]')
    })

    let connCounter = 0;
    this.servers.http.on('connection', conn => {
      let connKey = `http:${conn.remoteAddress}:${conn.remotePort}:${connCounter}`
      connCounter += 1
      this.connections.set(connKey, conn)
      ratelimitedUpdateStatus()
      conn.on('close', () => {
        this.connections.delete(connKey)
        this.connectionsCompleted += 1
        ratelimitedUpdateStatus()
      })
    })
    if (!WIKI.config.lateBindHTTP) {
      await this.listenHTTP();
    }
  },
  /**
   * Start listening for http requests.
   *
   * NOTE: This is split from the creation of the server, as we want to wait
   * for other parts of the system to finishing loading before serving our
   * first request.
   */
  async listenHTTP() {
    if (this.listenCalled.http) {
      return
    }
    this.listenCalled.http = true
    listenServer(WIKI.config, this.servers.http)
  },
  /**
   * Start HTTPS Server
   */
  async startHTTPS () {
    if (WIKI.config.ssl.provider === 'letsencrypt') {
      this.le = require('./letsencrypt')
      await this.le.init()
    }

    WIKI.logger.info(`HTTPS Server on port: [ ${WIKI.config.ssl.port} ]`)
    const tlsOpts = {}
    try {
      if (WIKI.config.ssl.format === 'pem') {
        tlsOpts.key = WIKI.config.ssl.inline ? WIKI.config.ssl.key : fs.readFileSync(WIKI.config.ssl.key)
        tlsOpts.cert = WIKI.config.ssl.inline ? WIKI.config.ssl.cert : fs.readFileSync(WIKI.config.ssl.cert)
      } else {
        tlsOpts.pfx = WIKI.config.ssl.inline ? WIKI.config.ssl.pfx : fs.readFileSync(WIKI.config.ssl.pfx)
      }
      if (!_.isEmpty(WIKI.config.ssl.passphrase)) {
        tlsOpts.passphrase = WIKI.config.ssl.passphrase
      }
      if (!_.isEmpty(WIKI.config.ssl.dhparam)) {
        tlsOpts.dhparam = WIKI.config.ssl.dhparam
      }
    } catch (err) {
      WIKI.logger.error('Failed to setup HTTPS server parameters:')
      WIKI.logger.error(err)
      return process.exit(1)
    }
    this.servers.https = https.createServer(tlsOpts, WIKI.app)
    this.servers.graph.installSubscriptionHandlers(this.servers.https)

    this.servers.https.on('error', (error) => {
      if (error.syscall !== 'listen') {
        throw error
      }

      switch (error.code) {
        case 'EACCES':
          WIKI.logger.error('Listening on port ' + WIKI.config.ssl.port + ' requires elevated privileges!')
          return process.exit(1)
        case 'EADDRINUSE':
          WIKI.logger.error('Port ' + WIKI.config.ssl.port + ' is already in use!')
          return process.exit(1)
        default:
          throw error
      }
    })

    this.servers.https.on('listening', () => {
      WIKI.logger.info('HTTPS Server: [ RUNNING ]')
    })

    let connCounter = 0;
    this.servers.https.on('connection', conn => {
      let connKey = `https:${conn.remoteAddress}:${conn.remotePort}:${connCounter}`
      connCounter += 1
      this.connections.set(connKey, conn)
      ratelimitedUpdateStatus()
      conn.on('close', () => {
        this.connections.delete(connKey)
        this.connectionsCompleted += 1
        ratelimitedUpdateStatus()
      })
    })

    if (!WIKI.config.lateBindHTTPS) {
      await this.listenHTTPS()
    }
  },
  async listenHTTPS() {
    if (this.listenCalled.https) {
      return
    }
    this.listenCalled.https = true
    listenServer({port: WIKI.config.ssl.port, bindIP: WIKI.config.bindIP}, this.servers.https)
  },
  /**
   * Start GraphQL Server
   */
  async startGraphQL () {
    const graphqlSchema = require('../graph')
    this.servers.graph = new ApolloServer({
      ...graphqlSchema,
      context: ({ req, res }) => ({ req, res }),
      subscriptions: {
        onConnect: (connectionParams, webSocket) => {

        },
        path: '/graphql-subscriptions'
      }
    })
    this.servers.graph.applyMiddleware({ app: WIKI.app, cors: false })
  },
  /**
   * Close all active connections
   */
  closeConnections (mode = 'all') {
    for (const [key, conn] of this.connections) {
      if (mode !== `all` && key.indexOf(`${mode}:`) !== 0) {
        continue
      }
      conn.destroy()
      this.connections.delete(key)
    }
    if (mode === 'all') {
      this.connections.clear()
    }
  },
  /**
   * Stop all servers
   */
  async stopServers () {
    this.closeConnections()
    if (this.servers.http) {
      await Promise.fromCallback(cb => { this.servers.http.close(cb) })
      this.servers.http = null
      this.listenCalled.http = false
    }
    if (this.servers.https) {
      await Promise.fromCallback(cb => { this.servers.https.close(cb) })
      this.servers.https = null
      this.listenCalled.https = false
    }
    this.servers.graph = null
  },
  /**
   * Restart Server
   */
  async restartServer (srv = 'https') {
    this.closeConnections(srv)
    switch (srv) {
      case 'http':
        if (this.servers.http) {
          await Promise.fromCallback(cb => { this.servers.http.close(cb) })
          this.servers.http = null
          this.listenCalled.http = false
        }
        await this.startHTTP()
        await this.listenHTTP()
        break
      case 'https':
        if (this.servers.https) {
          await Promise.fromCallback(cb => { this.servers.https.close(cb) })
          this.servers.https = null
          this.listenCalled.https = false
        }
        await this.startHTTPS()
        await this.listenHTTPS()
        break
      default:
        throw new Error('Cannot restart server: Invalid designation')
    }
  }
}
