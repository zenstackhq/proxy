#!/usr/bin/env node

import { Command, CommanderError } from 'commander'
import * as path from 'path'
import * as fs from 'fs'
import { grey, red } from 'colors'
import { startServer } from './server'
import { parseZModelSchema } from './zmodel-parser'
import 'dotenv/config'
import { getVersion } from './utils/version-utils'
import { telemetry } from './telemetry'
import { CliError } from './cli-error'
export function createProgram() {
  const program = new Command()

  program
    .name('zenstack-proxy')
    .description('CLI tool to run ZenStack proxy server')
    .version(getVersion()!)

  program
    .option('-z, --zenstack <path>', 'Path to ZenStack generated folder')
    .option('-p, --port <number>', 'Port number for the server', '2311')
    .option('-s, --schema <path>', 'Path to ZModel schema file', 'schema.zmodel')
    .option('-d, --datasource-url <url>', 'Datasource URL (overrides schema configuration)')
    .option('--public-api-key <key>', 'Public API key used to verify request signatures')
    .option('-l, --log <level...>', 'Query log levels (e.g., query, info, warn, error)')
    .action(async (options) => {
      // Determine ZModel schema path
      const zmodelPath = path.isAbsolute(options.schema)
        ? options.schema
        : path.join(process.cwd(), options.schema)

      if (!fs.existsSync(zmodelPath)) {
        console.error(`ZModel schema file not found: ${zmodelPath}`)
        console.error('Please provide a valid path using the -s option.')
        process.exit(1)
      }
      console.log(grey(`Loading ZModel schema from: ${zmodelPath}`))
      // Parse ZModel schema
      const zmodelConfig = parseZModelSchema(zmodelPath, options.datasourceUrl)
      const zmodelSchemaDir = path.dirname(zmodelPath)

      // Start the server
      await startServer({
        zenstackPath: options.zenstack,
        port: parseInt(options.port),
        zmodelConfig: zmodelConfig,
        zmodelSchemaDir: zmodelSchemaDir,
        logLevel: options.log,
        publicAPIKey: options.publicApiKey,
      })
    })

  return program
}

export default async function () {
  const program = createProgram()
  // handle errors explicitly to ensure telemetry
  program.exitOverride()
  let exitCode = 1
  try {
    await telemetry.trackCli(async () => {
      await program.parseAsync()
    })
  } catch (e: unknown) {
    if (e instanceof CommanderError) {
      // ignore
      exitCode = e.exitCode
    } else if (e instanceof CliError) {
      console.error(red(e.message))
    } else {
      if (e instanceof Error) {
        console.error(red(`Unhandled error: ${e.message}`))
      } else {
        console.error(red(`Unhandled error: ${String(e)}`))
      }
    }
    if (telemetry.isTracking) {
      // give telemetry a chance to send events before exit
      setTimeout(() => {
        process.exit(exitCode)
      }, 200)
    }
  }
}
