"use strict";

const _ = require('underscore')
const common = require('duniter-common')

const Block = common.document.Block

module.exports = {
  stat: (stat) => {
    return { "blocks": stat.blocks }
  },
  block: (block) => {
    const json = {};
    [
      "version",
      "nonce",
      "number",
      "powMin",
      "time",
      "medianTime",
      "membersCount",
      "monetaryMass",
      "unitbase",
      "issuersCount",
      "issuersFrame",
      "issuersFrameVar",
      "len"
    ].forEach((field) => {
      json[field] = parseInt(block[field], 10);
    });
    [
      "currency",
      "issuer",
      "signature",
      "hash",
      "parameters"
    ].forEach((field) => {
      json[field] = block[field] || "";
    });
    [
      "previousHash",
      "previousIssuer",
      "inner_hash"
    ].forEach((field) => {
      json[field] = block[field] || null;
    });
    [
      "dividend"
    ].forEach((field) => {
      json[field] = parseInt(block[field]) || null;
    });
    [
      "identities",
      "joiners",
      "actives",
      "leavers",
      "revoked",
      "excluded",
      "certifications"
    ].forEach((field) => {
      json[field] = [];
      block[field].forEach((raw) => {
        json[field].push(raw);
      });
    });
    [
      "transactions"
    ].forEach((field) => {
      json[field] = [];
      block[field].forEach((obj) => {
        json[field].push(_(obj).omit('raw', 'certifiers', 'hash'));
      });
      json.transactions = block.transactions.map(tx => {
        tx.inputs = tx.inputs.map(i => i.raw || i)
        tx.outputs = tx.outputs.map(o => o.raw || o)
        return tx
      })
    });
    json.raw = Block.toRAWinnerPartWithHashAndNonce(block);
    return json;
  }
}