'use strict'

const uuid = require('uuid/v1')
const crypto = require('crypto')

const Scheduler = module.exports = function (options) {
  this.pipelineNamespace = options.pipelineNamespace
  this.pipelineServiceAccount = options.pipelineServiceAccount
  this.kubernetes = options.kubernetes
}

Scheduler.prototype.pipelineToPods = function (pipeline) {
  const runId = uuid()
  return pipeline.steps.map(step => this.stepToPod(step, runId))
}

Scheduler.prototype.schedulePipeline = async function (pipeline) {
  const pods = this.pipelineToPods(pipeline);
  return Promise.all(
    pods.map(pod => 
      this.kubernetes.createNamespacedPod(
        pod.metadata.namespace,
        pod
      )
    )
  )
}

Scheduler.prototype.stepToPod = function (step, runId) {
  const stepRunId = uuid()
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      namespace: this.pipelineNamespace,
      name: `${stepRunId}`,
      labels: {
        'io.crafto.mason/pipeline-run-id': runId,
        'io.crafto.mason': 'true',
        'io.crafto.mason/step-run-id': stepRunId,
        'io.crafto.mason/step-name': step.name,
        'io.crafto.mason/step-id': crypto.createHash('md5').update(step.name).digest('hex'),
      },
    },
    spec: {
      serviceAccountName: this.pipelineServiceAccount,
      initContainers: this.dependenciesToInitContainers(
        step.depends_on || [],
        runId
      ),
      containers: [ this.stepToPodContainer(step) ],
      restartPolicy: 'Never'
    }
  }
}

Scheduler.prototype.stepToPodContainer = function (step) {
  return {
    name: uuid(),
    image: step.image,
    imagePullPolicy: 'Always',
    command: ['/bin/bash'],
    args: ['-c', step.commands.join(' && ')]
  }
}

Scheduler.prototype.dependenciesToInitContainers = function (dependencies, runId) {
  return dependencies.map(dependency => {
    const depStepId = crypto.createHash('md5').update(dependency).digest('hex')
    return {
      name: uuid(),
      image: 'groundnuty/k8s-wait-for:v1.2',
      imagePullPolicy: "Always",
      args: [ 'pod', `-lio.crafto.mason=true,io.crafto.mason/pipeline-run-id=${runId},io.crafto.mason/step-id=${depStepId}` ]
    }
  })
}
