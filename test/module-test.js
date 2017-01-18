"use strict";
const should = require('should');
const co  = require('co');
const duniterBMA = require('../index');
const duniterKeypair = require('duniter-keypair');
const duniter = require('duniter');
const logger = require('duniter/app/lib/logger')();
const rp = require('request-promise');

// Do not pollute the tests with logs
logger.mute();

describe('Module usage', () => {

  it('/node/summary should answer', () => co(function*() {
    const stack = duniter.statics.minimalStack();
    stack.registerDependency(duniterKeypair, 'duniter-keypair');
    stack.registerDependency(duniterBMA,     'duniter-bma');
    stack.registerDependency({
      duniter: {
        cli: [{
          name: 'test',
          desc: 'Unit Test execution',
          onDatabaseExecute: (server, conf, program, params, startServices) => co(function*() {
            yield startServices();
          })
        }]
      }
    }, 'duniter-automated-test');
    yield stack.executeStack(['node', 'index.js', 'test',
      '--memory',
      '--ipv4', '127.0.0.1',
      '--port', '10400'
    ]);
    const json = yield rp.get({
      url: 'http://127.0.0.1:10400/node/summary',
      json: true,
      timeout: 1000
    });
    should.exist(json);
    json.should.have.property('duniter').property('software').equal('duniter');
  }));
});
