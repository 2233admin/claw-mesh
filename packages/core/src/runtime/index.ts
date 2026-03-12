export { DockerRunner } from './docker-runner'
export { NativeRunner } from './native-runner'
export { WasmRunner } from './wasm-runner'
export { GVisorRunner } from './gvisor-runner'
export type { TaskRunner, AgentHandle, ExecResult, ResourceSpec, RuntimeMetrics } from '../types/runtime'

import { DockerRunner } from './docker-runner'
import { NativeRunner } from './native-runner'
import { WasmRunner } from './wasm-runner'
import { GVisorRunner } from './gvisor-runner'
import type { TaskRunner } from '../types/runtime'

export function createRunner(runtime: string): TaskRunner {
  switch (runtime) {
    case 'docker': return new DockerRunner()
    case 'native': return new NativeRunner()
    case 'wasm': return new WasmRunner()
    case 'gvisor': return new GVisorRunner()
    default: return new NativeRunner()
  }
}
