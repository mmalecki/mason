#!/usr/bin/env node
const Scheduler = require('../scheduler.js')
const bodyJson = require('body/json')
const sendError = require('send-error')

const Server = module.exports = function(config) {
  this.scheduler = new Scheduler(config.scheduler)
}

Server.prototype.handler = function (req, res) {
  const split = req.url.split('/').filter(Boolean)

  if (req.method === 'POST' && split.length === 1 split[0] === 'schedule')
    return this.handleSchedule(req, res)
  else return sendError(req, res, new Error('Not found'))
}

Server.prototype.handleSchedule = function (req, res) {
  bodyJson(req, res, (err, body) => {
    if (err) return sendError(req, res, err)
    const triggerEvent = body.triggerEvent
    const pipelines = body.pipelines

    const pipelineRuns = pipelines.map(pipeline =>
      self.scheduler.schedulePipeline(pipeline, triggerEvent)
    )
  })
}
