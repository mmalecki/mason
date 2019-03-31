'use strict'

const uuid = require('uuid/v1')
const crypto = require('crypto')

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

const Scheduler = module.exports = function (options) {
  this.pipelineNamespace = options.pipelineNamespace
  this.pipelineServiceAccount = options.pipelineServiceAccount
  this.kubernetes = options.kubernetes
}

Scheduler.prototype.pipelineToPods = function (pipeline, runId) {
  return pipeline.steps.map((step, idx) => {
    if (!step.depends_on && idx > 0)
      step.depends_on = [pipeline.steps[idx - 1].name]
    return this.stepToPod(step, runId)
  })
}

Scheduler.prototype.schedulePipeline = async function (pipeline) {
  const runId = uuid()
  const pods = this.pipelineToPods(pipeline, runId);

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
        'io.crafto.mason/step-id': md5(step.name)
      },
    },
    spec: {
      serviceAccountName: this.pipelineServiceAccount,
      initContainers: this.dependenciesToInitContainers(
        step.depends_on || [],
        runId
      ),
      containers: [ this.stepToPodContainer(step, runId) ],
      restartPolicy: 'Never',
      volumes: [
        {
          name: 'workspace',
          persistentVolumeClaim: { claimName: 'nfs' },
        }
      ]
    }
  }
}

Scheduler.prototype.pvc = function (runId) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: runId,
      labels: {
        'io.crafto.mason/pipeline-run-id': runId,
        'io.crafto.mason': 'true',
      }
    },
    spec: {
      accessModes: ['ReadWriteMany'],
      resources: {
        requests: { storage: '10Gi' }
      }
    }
  }
}

Scheduler.prototype.stepToPodContainer = function (step, runId) {
  return {
    name: uuid(),
    image: step.image,
    imagePullPolicy: 'Always',
    command: ['/bin/bash'],
    args: ['-c', step.commands.join(' && ')],
    volumeMounts: [
      {
        name: 'workspace',
        mountPath: '/mason',
        subPath: runId,
      }
    ],
    workingDir: '/mason'
  }
}

Scheduler.prototype.dependenciesToInitContainers = function (dependencies, runId) {
  return dependencies.map(dependency => {
    const depStepId = md5(dependency)
    return {
      name: uuid(),
      image: 'groundnuty/k8s-wait-for:v1.2',
      imagePullPolicy: "Always",
      args: [ 'pod', `-lio.crafto.mason=true,io.crafto.mason/pipeline-run-id=${runId},io.crafto.mason/step-id=${depStepId}` ]
    }
  })
}
