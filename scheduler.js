'use strict'

const uuid = require('uuid/v1')
const crypto = require('crypto')
const k8s = require('@kubernetes/client-node')
const PipelineRun = require('./lib/pipeline-run.js')

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function randomHexBytes(count) {
  return crypto.randomBytes(count).toString('hex')
}

function kubernetifyName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-\.]/, '-')
}

const Scheduler = module.exports = function (options) {
  this.pipelineNamespace = options.pipelineNamespace
  this.pipelineServiceAccount = options.pipelineServiceAccount
  this.kubernetesConfig = options.kubernetes
  this.kubernetes = this.kubernetesConfig.makeApiClient(k8s.Core_v1Api)
  this.watcher = new k8s.Watch(this.kubernetesConfig)
}

Scheduler.prototype.stepNameToPodName = function (stepName, runId) {
  return runId + `-` + kubernetifyName(stepName)
}

Scheduler.prototype.pipelineToPods = function (pipeline, runId) {
  return pipeline.steps.map((step, idx) => {
    if (!step.depends_on && idx > 0)
      step.depends_on = [pipeline.steps[idx - 1].name]

    return this.stepToPod(step, runId)
  })
}

Scheduler.prototype.schedulePipeline = async function (pipeline, triggerEvent) {
  const runId = kubernetifyName(pipeline.name) + '-' + randomHexBytes(4)
  const pods = this.pipelineToPods(pipeline, runId)

  return Promise.all(
    pods.map(pod =>
      this.kubernetes.createNamespacedPod(
        pod.metadata.namespace,
        pod
      )
    )
  ).then(pods =>
    this.watchPipeline(new PipelineRun({
      pipeline,
      triggerEvent,
      runId,
      pods: pods.map(pod => pod.body)
    })
  ))
}

Scheduler.prototype.stepToPod = function (step, runId) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      namespace: this.pipelineNamespace,
      name: runId + '-' + kubernetifyName(step.name),
      labels: {
        'io.crafto.mason': 'true',
        'io.crafto.mason/pipeline-run-id': runId,
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
    name: kubernetifyName(step.name),
    image: step.image,
    imagePullPolicy: 'Always',
    command: ['/bin/sh'],
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
      name: 'wait-for-' + kubernetifyName(dependency),
      image: 'groundnuty/k8s-wait-for:v1.2',
      imagePullPolicy: 'IfNotPresent',
      args: [ 'pod', `-lio.crafto.mason=true,io.crafto.mason/pipeline-run-id=${runId},io.crafto.mason/step-id=${depStepId}` ]
    }
  })
}

Scheduler.prototype.watchPipeline = async function (pipelineRun) {
  const req = this.watcher.watch(
    `/api/v1/namespaces/${this.pipelineNamespace}/pods`,
    {
      labelSelector: `io.crafto.mason/pipeline-run-id=${pipelineRun.runId}`
    },
    (type, obj) => {
      if (type !== 'MODIFIED') return;
      // XXX(mmalecki): this stinks
      pipelineRun._updatePod(obj)
    }
  )

  return pipelineRun
}
