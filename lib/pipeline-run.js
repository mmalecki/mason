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
  this.stepPhases = new Array(this.pods.length).fill(PipelineRun.PHASE.PENDING)

  EventEmitter.call(this)
}
util.inherits(PipelineRun, EventEmitter)

function phaseFromKubernetesPhase(phase) {
  return ({
    'Pending': PipelineRun.PHASE.PENDING,
    'Running': PipelineRun.PHASE.RUNNING,
    'Succeeded': PipelineRun.PHASE.SUCCEEDED,
    'Failed': PipelineRun.PHASE.FAILED,
  })[phase]
}

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
PipelineRun.prototype._syncPipelineStatus = function () {
  if (this.phase === PipelineRun.PHASE.PENDING &&
      this.stepPhases.some(phase => phase === PipelineRun.PHASE.RUNNING)) {
    this.phase = PipelineRun.PHASE.RUNNING
    this.emit('running')
  }

  let failed = this.stepPhases.filter(phase => phase === PipelineRun.PHASE.FAILED)
  let succeeded = this.stepPhases.filter(phase => phase === PipelineRun.PHASE.SUCCEEDED)
  if (failed.length + succeeded.length === this.pods.length) {
    this.completed = true
    this.emit('completed')

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
  const podIndex = this.pods.findIndex(pod => pod.metadata.uid === update.metadata.uid)
  if (podIndex === -1) {
    console.error(`no such Pod(${update.metadata.name}) found for this PipelineRun(${this.runId}`)
    return
  }

  let pod = this.pods[podIndex]

  if (pod.status.phase !== update.status.phase) {
    this.stepPhases[podIndex] = phaseFromKubernetesPhase(update.status.phase)
  }
  pod.status = update.status

  this._syncPipelineStatus()
}
