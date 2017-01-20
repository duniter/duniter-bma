"use strict";

const Q = require('q');
const co = require('co');
const os = require('os');
const async = require('async');
const _ = require('underscore');
const util = require('util');
const stream = require('stream');
const constants = require('./lib/constants');
const upnp = require('./lib/upnp');
const bma = require('./lib/bma');
const dtos = require('./lib/dtos');
const sanitize = require('./lib/sanitize');
const network = require('./lib/network');
const http2raw = require('./lib/http2raw');
const inquirer = require('inquirer');

module.exports = {
  duniter: {

    cliOptions: [
      { value: '--upnp', desc: 'Use UPnP to open remote port.' },
      { value: '--noupnp', desc: 'Do not use UPnP to open remote port.' },
      { value: '-p, --port <port>', desc: 'Port to listen for requests', parser: (val) => parseInt(val) },
      { value: '--ipv4 <address>', desc: 'IPv4 interface to listen for requests' },
      { value: '--ipv6 <address>', desc: 'IPv6 interface to listen for requests' },
      { value: '--remoteh <host>', desc: 'Remote interface others may use to contact this node' },
      { value: '--remote4 <host>', desc: 'Remote interface for IPv4 access' },
      { value: '--remote6 <host>', desc: 'Remote interface for IPv6 access' },
      { value: '--remotep <port>', desc: 'Remote port others may use to contact this node' },
    ],

    wizard: {

      'network': (conf, program, logger) => co(function*() {
        yield Q.nbind(networkConfiguration, null, conf, logger)();
      }),

      'network-reconfigure': (conf, program, logger) => co(function*() {
        yield Q.nbind(networkReconfiguration, null, conf, logger, program.autoconf, program.noupnp)();
      })
    },

    config: {

      onLoading: (conf, program, logger) => co(function*(){

        if (program.port) conf.port = program.port;
        if (program.ipv4) conf.ipv4 = program.ipv4;
        if (program.ipv6) conf.ipv6 = program.ipv6;
        if (program.remoteh) conf.remotehost = program.remoteh;
        if (program.remote4) conf.remoteipv4 = program.remote4;
        if (program.remote6) conf.remoteipv6 = program.remote6;
        if (program.remotep) conf.remoteport = program.remotep;

        // Default remote: same as local if defined
        if (!conf.remoteipv4 && conf.ipv4) {
          conf.remoteipv4 = conf.ipv4;
        }
        if (!conf.remoteipv6 && conf.ipv6) {
          conf.remoteipv6 = conf.ipv6;
        }
        if (!conf.remoteport && conf.port) {
          conf.remoteport = conf.port;
        }

        // Network autoconf
        const autoconfNet = program.autoconf
          || !(conf.ipv4 || conf.ipv6)
          || !(conf.remoteipv4 || conf.remoteipv6 || conf.remotehost)
          || !(conf.port && conf.remoteport);
        if (autoconfNet) {
          yield Q.nbind(networkReconfiguration, null)(conf, autoconfNet, logger, program.noupnp);
        }

        // Default value
        if (conf.upnp === undefined || conf.upnp === null) {
          conf.upnp = true; // Defaults to true
        }

        // UPnP
        if (program.noupnp === true) {
          conf.upnp = false;
        }
        if (program.upnp === true) {
          conf.upnp = true;
        }

        // Configuration errors
        if(!conf.ipv4 && !conf.ipv6){
          throw new Error("No interface to listen to.");
        }
        if(!conf.remoteipv4 && !conf.remoteipv6 && !conf.remotehost){
          throw new Error('No interface for remote contact.');
        }
        if (!conf.remoteport) {
          throw new Error('No port for remote contact.');
        }
      })
    },

    service: {
      input: (server, conf, logger) => new BMAPI(server, conf, logger)
    },

    methods: {
      noLimit: () => require('./lib/limiter').noLimit(),
      bma, sanitize, dtos,
      upnpConf: network.upnpConf,
      getRandomPort: network.getRandomPort,
      listInterfaces: network.listInterfaces,
      getBestLocalIPv6: network.getBestLocalIPv6,
      getBestLocalIPv4: network.getBestLocalIPv4,
      createServersAndListen: network.createServersAndListen,
      http2raw
    }
  }
}

function BMAPI(server, conf, logger) {

  // Public http interface
  let bmapi;
  // UPnP API
  let upnpAPI;

  stream.Transform.call(this, { objectMode: true });

  this.startService = () => co(function*() {
    bmapi = yield bma(server, null, server.conf.httplogs, logger);
    yield bmapi.openConnections();

    /***************
     *    UPnP
     **************/
    if (upnpAPI) {
      upnpAPI.stopRegular();
    }
    if (server.conf.upnp) {
      try {
        upnpAPI = yield upnp(server.conf.port, server.conf.remoteport, logger);
        upnpAPI.startRegular();
        const gateway = yield upnpAPI.findGateway();
        if (gateway) {
          if (bmapi.getDDOS().params.whitelist.indexOf(gateway) === -1) {
            bmapi.getDDOS().params.whitelist.push(gateway);
          }
        }
      } catch (e) {
        logger.warn(e);
      }
    }
  });

  this.stopService = () => co(function*() {
    if (bmapi) {
      yield bmapi.closeConnections();
    }
    if (upnpAPI) {
      upnpAPI.stopRegular();
    }
  });
}



function networkReconfiguration(conf, autoconf, logger, noupnp, done) {
  async.waterfall([
    upnpResolve.bind(this, noupnp, logger),
    function(upnpSuccess, upnpConf, next) {

      // Default values
      conf.port = conf.port || constants.DEFAULT_PORT;
      conf.remoteport = conf.remoteport || constants.DEFAULT_PORT;

      const localOperations = getLocalNetworkOperations(conf, autoconf);
      const remoteOpertions = getRemoteNetworkOperations(conf, upnpConf.remoteipv4, upnpConf.remoteipv6, autoconf);
      const dnsOperations = getHostnameOperations(conf, logger, autoconf);
      const useUPnPOperations = getUseUPnPOperations(conf, logger, autoconf);

      if (upnpSuccess) {
        _.extend(conf, upnpConf);
        const local = [conf.ipv4, conf.port].join(':');
        const remote = [conf.remoteipv4, conf.remoteport].join(':');
        if (autoconf) {
          conf.ipv6 = conf.remoteipv6 = network.getBestLocalIPv6();
          logger.info('IPv6: %s', conf.ipv6 || "");
          logger.info('Local IPv4: %s', local);
          logger.info('Remote IPv4: %s', remote);
          // Use proposed local + remote with UPnP binding
          return async.waterfall(useUPnPOperations
            .concat(dnsOperations), next);
        }
        choose("UPnP is available: duniter will be bound: \n  from " + local + "\n  to " + remote + "\nKeep this configuration?", true,
          function () {
            // Yes: not network changes
            conf.ipv6 = conf.remoteipv6 = network.getBestLocalIPv6();
            async.waterfall(useUPnPOperations
              .concat(dnsOperations), next);
          },
          function () {
            // No: want to change
            async.waterfall(
              localOperations
                .concat(remoteOpertions)
                .concat(useUPnPOperations)
                .concat(dnsOperations), next);
          });
      } else {
        conf.upnp = false;
        if (autoconf) {
          // Yes: local configuration = remote configuration
          return async.waterfall(
            localOperations
              .concat(getHostnameOperations(conf, logger, autoconf))
              .concat([function (confDone) {
                conf.remoteipv4 = conf.ipv4;
                conf.remoteipv6 = conf.ipv6;
                conf.remoteport = conf.port;
                logger.info('Local & Remote IPv4: %s', [conf.ipv4, conf.port].join(':'));
                logger.info('Local & Remote IPv6: %s', [conf.ipv6, conf.port].join(':'));
                confDone();
              }]), next);
        }
        choose("UPnP is *not* available: is this a public server (like a VPS)?", true,
          function () {
            // Yes: local configuration = remote configuration
            async.waterfall(
              localOperations
                .concat(getHostnameOperations(conf, logger))
                .concat([function(confDone) {
                  conf.remoteipv4 = conf.ipv4;
                  conf.remoteipv6 = conf.ipv6;
                  conf.remoteport = conf.port;
                  confDone();
                }]), next);
          },
          function () {
            // No: must give all details
            async.waterfall(
              localOperations
                .concat(remoteOpertions)
                .concat(dnsOperations), next);
          });
      }
    }
  ], done);
}


function upnpResolve(noupnp, logger, done) {
  return co(function *() {
    try {
      let conf = yield network.upnpConf(noupnp, logger);
      done(null, true, conf);
    } catch (err) {
      done(null, false, {});
    }
  });
}

function networkConfiguration(conf, logger, done) {
  async.waterfall([
    upnpResolve.bind(this, !conf.upnp, logger),
    function(upnpSuccess, upnpConf, next) {

      let operations = getLocalNetworkOperations(conf)
        .concat(getRemoteNetworkOperations(conf, upnpConf.remoteipv4, upnpConf.remoteipv6));

      if (upnpSuccess) {
        operations = operations.concat(getUseUPnPOperations(conf, logger));
      }

      async.waterfall(operations.concat(getHostnameOperations(conf, logger, false)), next);
    }
  ], done);
}

function getLocalNetworkOperations(conf, autoconf) {
  return [
    function (next){
      const osInterfaces = network.listInterfaces();
      const interfaces = [{ name: "None", value: null }];
      osInterfaces.forEach(function(netInterface){
        const addresses = netInterface.addresses;
        const filtered = _(addresses).where({family: 'IPv4'});
        filtered.forEach(function(addr){
          interfaces.push({
            name: [netInterface.name, addr.address].join(' '),
            value: addr.address
          });
        });
      });
      if (autoconf) {
        conf.ipv4 = network.getBestLocalIPv4();
        return next();
      }
      inquirer.prompt([{
        type: "list",
        name: "ipv4",
        message: "IPv4 interface",
        default: conf.ipv4,
        choices: interfaces
      }], function (answers) {
        conf.ipv4 = answers.ipv4;
        next();
      });
    },
    function (next){
      const osInterfaces = network.listInterfaces();
      const interfaces = [{ name: "None", value: null }];
      osInterfaces.forEach(function(netInterface){
        const addresses = netInterface.addresses;
        const filtered = _(addresses).where({ family: 'IPv6' });
        filtered.forEach(function(addr){
          let address = addr.address
          if (addr.scopeid)
            address += "%" + netInterface.name
          let nameSuffix = "";
          if (addr.scopeid == 0 && !addr.internal) {
            nameSuffix = " (Global)";
          }
          interfaces.push({
            name: [netInterface.name, address, nameSuffix].join(' '),
            internal: addr.internal,
            scopeid: addr.scopeid,
            value: address
          });
        });
      });
      interfaces.sort((addr1, addr2) => {
        if (addr1.value === null) return -1;
        if (addr1.internal && !addr2.internal) return 1;
        if (addr1.scopeid && !addr2.scopeid) return 1;
        return 0;
      });
      if (autoconf || !conf.ipv6) {
        conf.ipv6 = conf.remoteipv6 = network.getBestLocalIPv6();
      }
      if (autoconf) {
        return next();
      }
      inquirer.prompt([{
        type: "list",
        name: "ipv6",
        message: "IPv6 interface",
        default: conf.ipv6,
        choices: interfaces
      }], function (answers) {
        conf.ipv6 = conf.remoteipv6 = answers.ipv6;
        next();
      });
    },
    autoconf ? (done) => {
        conf.port = network.getRandomPort(conf);
        done();
      } : async.apply(simpleInteger, "Port", "port", conf)
  ];
}

function getRemoteNetworkOperations(conf, remoteipv4) {
  return [
    function (next){
      if (!conf.ipv4) {
        conf.remoteipv4 = null;
        return next(null, {});
      }
      const choices = [{ name: "None", value: null }];
      // Local interfaces
      const osInterfaces = network.listInterfaces();
      osInterfaces.forEach(function(netInterface){
        const addresses = netInterface.addresses;
        const filtered = _(addresses).where({family: 'IPv4'});
        filtered.forEach(function(addr){
          choices.push({
            name: [netInterface.name, addr.address].join(' '),
            value: addr.address
          });
        });
      });
      if (conf.remoteipv4) {
        choices.push({ name: conf.remoteipv4, value: conf.remoteipv4 });
      }
      if (remoteipv4 && remoteipv4 != conf.remoteipv4) {
        choices.push({ name: remoteipv4, value: remoteipv4 });
      }
      choices.push({ name: "Enter new one", value: "new" });
      inquirer.prompt([{
        type: "list",
        name: "remoteipv4",
        message: "Remote IPv4",
        default: conf.remoteipv4 || conf.ipv4 || null,
        choices: choices,
        validate: function (input) {
          return !!(input && input.toString().match(constants.IPV4_REGEXP));
        }
      }], function (answers) {
        if (answers.remoteipv4 == "new") {
          inquirer.prompt([{
            type: "input",
            name: "remoteipv4",
            message: "Remote IPv4",
            default: conf.remoteipv4 || conf.ipv4,
            validate: function (input) {
              return !!(input && input.toString().match(constants.IPV4_REGEXP));
            }
          }], async.apply(next, null));
        } else {
          next(null, answers);
        }
      });
    },
    function (answers, next){
      conf.remoteipv4 = answers.remoteipv4;
      return co(function*() {
        try {
          if (conf.remoteipv4 || conf.remotehost) {
            yield new Promise((resolve, reject) => {
              const getPort = async.apply(simpleInteger, "Remote port", "remoteport", conf);
              getPort((err) => {
                if (err) return reject(err);
                resolve();
              });
            });
          } else if (conf.remoteipv6) {
            conf.remoteport = conf.port;
          }
          next();
        } catch (e) {
          next(e);
        }
      });
    }
  ];
}

function getHostnameOperations(conf, logger, autoconf) {
  return [function(next) {
    if (!conf.ipv4) {
      conf.remotehost = null;
      return next();
    }
    if (autoconf) {
      logger.info('DNS: %s', conf.remotehost || 'No');
      return next();
    }
    choose("Does this server has a DNS name?", !!conf.remotehost,
      function() {
        // Yes
        simpleValue("DNS name:", "remotehost", "", conf, function(){ return true; }, next);
      },
      function() {
        conf.remotehost = null;
        next();
      });
  }];
}

function getUseUPnPOperations(conf, logger, autoconf) {
  return [function(next) {
    if (!conf.ipv4) {
      conf.upnp = false;
      return next();
    }
    if (autoconf) {
      logger.info('UPnP: %s', 'Yes');
      conf.upnp = true;
      return next();
    }
    choose("UPnP is available: use automatic port mapping? (easier)", conf.upnp,
      function() {
        conf.upnp = true;
        next();
      },
      function() {
        conf.upnp = false;
        next();
      });
  }];
}

function choose (question, defaultValue, ifOK, ifNotOK) {
  inquirer.prompt([{
    type: "confirm",
    name: "q",
    message: question,
    default: defaultValue
  }], function (answer) {
    answer.q ? ifOK() : ifNotOK();
  });
}

function simpleValue (question, property, defaultValue, conf, validation, done) {
  inquirer.prompt([{
    type: "input",
    name: property,
    message: question,
    default: conf[property],
    validate: validation
  }], function (answers) {
    conf[property] = answers[property];
    done();
  });
}

function simpleInteger (question, property, conf, done) {
  simpleValue(question, property, conf[property], conf, function (input) {
    return input && input.toString().match(/^[0-9]+$/) ? true : false;
  }, done);
}

util.inherits(BMAPI, stream.Transform);
