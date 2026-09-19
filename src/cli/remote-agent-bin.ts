#!/usr/bin/env node
import './remote-agent-polyfill.js'
import { runRemoteAgentBin } from './remote-agent-entry.js'

const code = await runRemoteAgentBin(process.argv.slice(2))
if (code !== 0) process.exit(code)
