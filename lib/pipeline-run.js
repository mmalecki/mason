'use strict'

const EventEmitter = require('events').EventEmitter
const util = require('util')

// PipelineRun is a thin abstraction of a single run of a pipeline, over multiple
// Kubernetes pods. It is a result of calling the scheduler to schedule a run
// of a Pipeline.
// Its `phase` property is stolen straight out of Kubernetes's pod `phase`
// property.
const PipelineRun = module.exports = function PipelineRun({
  pipeline,
  triggerEvent,
  runId,
  pods
}) {
  this.pipeline = pipeline
  this.triggerEvent = triggerEvent
  this.runId = runId
  this.pods = pods
  this.phase = PipelineRun.PHASE.PENDING

  EventEmitter.call(this)
}
util.inherits(PipelineRun, EventEmitter)

PipelineRun.PHASE = Object.freeze({
  PENDING: Symbol('pending'),
  RUNNING: Symbol('running'),
  SUCCEEDED: Symbol('succeeded'),
  FAILED: Symbol('failed')
})

// Sync this `PipelineRun`'s status with the status of all its pods.
// Transitions are as follows:
//
// PENDING -> RUNNING, once any pod is in Running phase.
// RUNNING -> FAILED, once all pods are finished, and any of the pods have failed
// RUNNING -> SUCCEEDED, once all the pods are in Succeeded phase
//
// Transition straight from PENDING to any of SUCCEEDED and FAILED is also
// allowed.
PipelineRun.prototype._syncStatus = function () {
  if (this.phase === PipelineRun.PHASE.PENDING &&
      this.pods.some(pod => pod.status.phase === 'Running')) {
    this.phase = PipelineRun.PHASE.RUNNING
    this.emit('running')
  }

  let failed = this.pods.filter(pod => pod.status.phase === 'Failed')
  let succeeded = this.pods.filter(pod => pod.status.phase === 'Succeeded')
  if (failed.length + succeeded.length === this.pods.length) {
    this.completed = true

    if (failed.length > 0) {
      this.phase = PipelineRun.PHASE.FAILED
      this.emit('failed', failed)
    }
    else {
      this.phase = PipelineRun.PHASE.SUCCEEDED
      this.emit('succeeded')
    }
  }
}

PipelineRun.prototype._updatePod = function (update) {
  let pod = this.pods.find(pod => pod.metadata.uid === update.metadata.uid)
  if (!pod) {
    console.error(`no such Pod(${pod.metadata.name}) found for this PipelineRun(${this.runId}`)
    return
  }

  pod.status = update.status
  this._syncStatus()
}
