import * as path from 'path'
import express from 'express'
import cors from 'cors'
import { ZenStackMiddleware } from '@zenstackhq/server/express'
import { ZModelConfig } from './zmodel-parser'
import { getNodeModulesFolder, getPrismaVersion, getZenStackVersion } from './utils/version-utils'
import { blue, grey, red, yellow } from 'colors'
import semver from 'semver'
import { CliError } from './cli-error'
import SuperJSON from 'superjson'
import { createSignatureMiddleware, normalizePublicKey } from './signature'

export interface ServerOptions {
  zenstackPath: string | undefined
  port: number
  zmodelConfig: ZModelConfig
  zmodelSchemaDir: string
  logLevel?: string[]
  publicAPIKey?: string
  signatureToleranceSecs: number
}

/**
 * Represents the identity claim embedded in the Authorization header.
 * The bearer token is a plain base64-encoded JSON string.
 */
type UserClaim = { type: 'superUser' } | { type: 'user'; data: Record<string, unknown> }

type EnhancementKind = 'password' | 'omit' | 'policy' | 'validation' | 'delegate' | 'encryption'
// enable all enhancements except policy
const Enhancements: EnhancementKind[] = ['password', 'omit', 'validation', 'delegate', 'encryption']

const VALID_OPS = new Set([
  'findMany',
  'findUnique',
  'findFirst',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
  'exists',
])

/**
 * Resolve the absolute path to the Prisma schema directory
 */
function resolvePrismaSchemaDir(config: ZModelConfig, zmodelSchemaDir: string): string {
  if (!config.prismaSchemaPath) {
    // Default: prisma directory relative to zmodel schema dir
    return path.join(zmodelSchemaDir, './prisma')
  }

  if (path.isAbsolute(config.prismaSchemaPath)) {
    // Already absolute, use as is
    return path.dirname(config.prismaSchemaPath)
  }

  // Relative to zmodel schema dir
  return path.dirname(path.join(zmodelSchemaDir, config.prismaSchemaPath))
}

/**
 * Resolve SQLite file URL to absolute path
 */
function resolveSQLitePath(filePath: string, prismaSchemaDir: string): string {
  // If already absolute, return as is
  if (path.isAbsolute(filePath)) {
    return filePath
  }
  // Convert relative path to absolute, relative to prisma schema directory
  return path.join(prismaSchemaDir, filePath)
}

function redactDatabaseUrl(url: string): string {
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.password) {
      parsedUrl.password = '***'
    }
    if (parsedUrl.username) {
      parsedUrl.username = '***'
    }
    return parsedUrl.toString()
  } catch {
    // If URL parsing fails, return the original (might be a file path for SQLite)
    return url
  }
}

/**
 * Create database adapter based on provider
 */
function createAdapter(config: ZModelConfig, zmodelSchemaDir: string): any {
  const { provider, url } = config.datasource

  switch (provider) {
    case 'sqlite': {
      try {
        // Check if URL is already absolute, otherwise resolve relative paths
        let resolvedUrl = url.trim()
        if (resolvedUrl.startsWith('file:')) {
          const filePath = resolvedUrl.substring(5)
          if (!path.isAbsolute(filePath)) {
            // Only resolve prisma schema dir if needed for relative paths
            const prismaSchemaDir = resolvePrismaSchemaDir(config, zmodelSchemaDir)
            resolvedUrl = `file:${resolveSQLitePath(filePath, prismaSchemaDir)}`
          }
        }
        const _mod = require('@prisma/adapter-better-sqlite3')
        //Prisma7 renamed PrismaBetterSqlite3 from PrismaBetterSQLite3, support both cases for compatibility
        const PrismaBetterSQLite3 =
          _mod.PrismaBetterSQLite3 ?? _mod.PrismaBetterSqlite3 ?? _mod.default

        console.log(grey(`Connecting to SQLite database at: ${resolvedUrl}`))
        return new PrismaBetterSQLite3({
          url: resolvedUrl,
        })
      } catch (error) {
        throw new CliError(
          'SQLite adapter dependencies not found. Install with: npm install better-sqlite3 @prisma/adapter-better-sqlite3'
        )
      }
    }
    case 'postgresql': {
      try {
        const { PrismaPg } = require('@prisma/adapter-pg')
        console.log(grey(`Connecting to PostgreSQL database at: ${redactDatabaseUrl(url)}`))
        return new PrismaPg({ connectionString: url })
      } catch (error) {
        throw new CliError(
          'PostgreSQL adapter dependencies not found. Install with: npm install pg @prisma/adapter-pg'
        )
      }
    }
    case 'mysql': {
      try {
        const { PrismaMariaDb } = require('@prisma/adapter-mariadb')
        console.log(grey(`Connecting to MySQL/MariaDB database at: ${redactDatabaseUrl(url)}`))
        return new PrismaMariaDb({
          url,
        })
      } catch (error) {
        throw new CliError(
          'MySQL/MariaDB adapter dependencies not found. Install with: npm install mariadb @prisma/adapter-mariadb'
        )
      }
    }
    default:
      throw new CliError(`Unsupported database provider: ${provider}`)
  }
}

/**
 * Loads PrismaClient, ModelMeta, enhance, and Enum modules for ZenStack
 */
async function loadZenStackModules(
  zmodelConfig: ZModelConfig,
  zmodelSchemaDir: string,
  zenstackPath?: string
) {
  // Register tsx to handle .ts files
  require('tsx/cjs/api').register()
  // Load ZenStack modules
  let modelMeta: any
  let enums: any
  // Load Prisma Client - either from custom output or default @prisma/client
  let PrismaClient: any
  let enhanceFunc: any

  const generator = zmodelConfig.generator
  if (generator.output) {
    // Use custom output path - resolve relative to zmodel schema file directory
    const prismaClientPath = path.isAbsolute(generator.output)
      ? path.join(generator.output, 'client')
      : path.join(resolvePrismaSchemaDir(zmodelConfig, zmodelSchemaDir), generator.output, 'client')
    console.log(grey(`Loading Prisma client from: ${prismaClientPath}`))
    let prismaModule
    try {
      prismaModule = require(prismaClientPath)
    } catch (err) {
      throw new CliError(
        `Failed to load Prisma client module from custom output path: ${prismaClientPath}. ` +
          `Please ensure the Prisma client has been generated by running 'prisma generate'.`
      )
    }
    PrismaClient = prismaModule.PrismaClient
    enums = prismaModule.$Enums || {}
  } else {
    // Use default @prisma/client - will now resolve from project's node_modules
    // Add the first node_modules directory up from zmodelSchemaDir for pnpm monorepo
    let foundNodeModules = getNodeModulesFolder(zmodelSchemaDir)
    if (foundNodeModules && !module.paths.includes(foundNodeModules)) {
      module.paths.unshift(foundNodeModules)
    }
    console.log(grey(`Loading Prisma client from: @prisma/client`))
    const prismaModule = require('@prisma/client')
    PrismaClient = prismaModule.PrismaClient
    enums = prismaModule.$Enums || {}
  }

  const zenstackAbsPath = zenstackPath
    ? path.isAbsolute(zenstackPath)
      ? zenstackPath
      : path.join(process.cwd(), zenstackPath)
    : undefined

  try {
    if (zenstackAbsPath) {
      modelMeta = require(path.join(zenstackAbsPath, 'model-meta')).default
      enhanceFunc = require(path.join(zenstackAbsPath, 'enhance')).enhance
    } else {
      modelMeta = require('@zenstackhq/runtime/model-meta').default
      enhanceFunc = require('@zenstackhq/runtime').enhance
    }
  } catch {
    throw new CliError(
      `Failed to load ZenStack generated model meta from: ${zenstackAbsPath || '@zenstackhq/runtime'}\n` +
        `Please run \`zenstack generate\` first or specify the correct output directory of ZenStack generated modules using the \`-z\` option.`
    )
  }

  if (!modelMeta.models) {
    throw new CliError(`Generated model meta not found. Please run \`zenstack generate\` first.`)
  }

  const zenstackVersion = getZenStackVersion()

  return { PrismaClient, modelMeta, enums, zenstackVersion, enhanceFunc }
}

function makeError(message: string, status = 400) {
  return { status, body: { error: message } }
}

function lowerCaseFirst(input: string) {
  return input.charAt(0).toLowerCase() + input.slice(1)
}

function isValidModel(modelMeta: any, modelName: string): boolean {
  return lowerCaseFirst(modelName) in modelMeta.models
}

function processRequestPayload(args: any) {
  if (args === null || args === undefined) {
    return args
  }
  const { meta, ...rest } = args
  if (meta?.serialization) {
    // superjson deserialization
    return SuperJSON.deserialize({ json: rest, meta: meta.serialization })
  } else {
    return args
  }
}

/**
 * Resolves the appropriate enhanced Prisma client for a request based on the Authorization header.
 *
 * - No publicAPIKey configured (authEnabled=false): return the standard enhanced client.
 * - superUser claim: return the standard enhanced client (no policy enforcement).
 * - Regular user claim: return the policy-enhanced client with the user identity.
 * - No / invalid token: return the standard enhanced client.
 */
function resolveEnhancedClient(
  prisma: any,
  enhanceFunc: (prisma: any, ctx: any, opts: any) => any,
  req: express.Request,
  authEnabled: boolean
): any {
  const baseClient = enhanceFunc(prisma, {}, { kinds: Enhancements })

  const authHeader = req.headers['authorization']

  if (!authEnabled && !authHeader) {
    return baseClient
  }

  if (!authHeader?.startsWith('Bearer ')) {
    return baseClient
  }

  const token = authHeader.substring(7)
  let claim: UserClaim
  try {
    claim = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as UserClaim
  } catch {
    return baseClient
  }

  if (claim.type === 'superUser') {
    return baseClient
  }

  if (claim.type === 'user') {
    // Enable policy enforcement with the user's identity context.
    return enhanceFunc(
      prisma,
      { user: claim.data },
      { kinds: [...Enhancements, 'policy'] as EnhancementKind[] }
    )
  }

  return baseClient
}

async function handleTransaction(modelMeta: any, client: any, requestBody: unknown) {
  const processedOps: Array<{ model: string; op: string; args: unknown }> = []
  if (!requestBody || !Array.isArray(requestBody) || requestBody.length === 0) {
    return makeError('request body must be a non-empty array of operations')
  }
  for (let i = 0; i < requestBody.length; i++) {
    const item = requestBody[i]
    if (!item || typeof item !== 'object') {
      return makeError(`operation at index ${i} must be an object`)
    }
    const { model: itemModel, op: itemOp, args: itemArgs } = item as any
    if (!itemModel || typeof itemModel !== 'string') {
      return makeError(`operation at index ${i} is missing a valid "model" field`)
    }
    if (!itemOp || typeof itemOp !== 'string') {
      return makeError(`operation at index ${i} is missing a valid "op" field`)
    }
    if (!VALID_OPS.has(itemOp)) {
      return makeError(`operation at index ${i} has invalid op: ${itemOp}`)
    }
    if (!isValidModel(modelMeta, itemModel)) {
      return makeError(`operation at index ${i} has unknown model: ${itemModel}`)
    }
    if (
      itemArgs !== undefined &&
      itemArgs !== null &&
      (typeof itemArgs !== 'object' || Array.isArray(itemArgs))
    ) {
      return makeError(`operation at index ${i} has invalid "args" field`)
    }

    processedOps.push({
      model: lowerCaseFirst(itemModel),
      op: itemOp,
      args: processRequestPayload(itemArgs),
    })
  }

  try {
    const clientResult = await client.$transaction(async (tx: any) => {
      const result: any[] = []
      for (const { model, op, args } of processedOps) {
        result.push(await (tx as any)[model][op](args))
      }
      return result
    })

    const { json, meta } = SuperJSON.serialize(clientResult)
    const responseBody: any = { data: json }
    if (meta) {
      responseBody.meta = { serialization: meta }
    }

    const response = { status: 200, body: responseBody }

    return response
  } catch (err) {
    console.error('error occurred when handling "$transaction" request:', err)
    return makeError(
      'Transaction failed: ' + (err instanceof Error ? err.message : String(err)),
      500
    )
  }
}

/**
 * Start the Express server with ZenStack proxy
 */
export async function startServer(options: ServerOptions) {
  const { zenstackPath, port, zmodelConfig, zmodelSchemaDir, publicAPIKey } = options

  const { PrismaClient, modelMeta, enums, zenstackVersion, enhanceFunc } =
    await loadZenStackModules(zmodelConfig, zmodelSchemaDir, zenstackPath)

  const prismaVersion = getPrismaVersion()

  const isPrisma7 = prismaVersion ? semver.gte(prismaVersion, '7.0.0') : false

  const isClientEngine = isPrisma7 || zmodelConfig.generator.engineType === 'client'

  const prisma = new PrismaClient({
    adapter: isClientEngine ? createAdapter(zmodelConfig, zmodelSchemaDir) : null,
    log: options.logLevel || [],
  })

  // Explicitly check the connection by running a simple query
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    throw new CliError('Database connection failed: ' + err)
  }

  // Warn when running without authentication.
  const publicAPIKey = options.publicAPIKey ?? process.env['ZENSTACK_STUDIO_AUTH_KEY']
  if (!publicAPIKey) {
    console.warn(
      yellow(
        'Warning: This proxy has no authentication. Do not expose it to the public network.\n' +
          'To secure it, get an API key from ZenStack Studio and set it via the ZENSTACK_STUDIO_AUTH_KEY environment variable.'
      )
    )
  }

  const app = express()

  app.use(cors())
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        // Capture the raw body string for use in signature verification.
        ;(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8')
      },
    })
  )
  app.use(express.urlencoded({ extended: true, limit: '5mb' }))

  if (publicAPIKey) {
    const toleranceSecs = options.signatureToleranceSecs ?? 60
    const normalizedKey = normalizePublicKey(publicAPIKey)
    app.use(['/api/model', '/api/schema'], createSignatureMiddleware(normalizedKey, toleranceSecs))
  }

  // ZenStack API endpoint

  app.post('/api/model/\\$transaction/sequential', async (_req, res) => {
    const response = await handleTransaction(
      modelMeta,
      resolveEnhancedClient(prisma, enhanceFunc, _req, !!publicAPIKey),
      _req.body
    )
    res.status(response.status).json(response.body)
  })

  app.use(
    '/api/model',
    ZenStackMiddleware({
      getPrisma: (req) => {
        return resolveEnhancedClient(prisma, enhanceFunc, req, !!publicAPIKey)
      },
    })
  )

  // Schema metadata endpoint
  app.get('/api/schema', (_req, res: express.Response) => {
    const result = {
      ...modelMeta,
      enums: enums,
      zenstackVersion,
      provider: {
        type: zmodelConfig.datasource.provider,
      },
    }
    res.json(result)
  })

  const server = app.listen(port, () => {
    console.log(`ZenStack proxy server is running on port: ${port}`)
    console.log(`ZenStack Studio is running at: ${blue('https://studio.zenstack.dev')}`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        red(
          `Port ${options.port} is already in use. Please choose a different port using -p option.`
        )
      )
    } else {
      throw new CliError(`Failed to start the server: ${err.message}`)
    }
    process.exit(1)
  })

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    server.close(() => {
      console.log('\nZenStack proxy server closed')
    })
    await prisma.$disconnect()
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    server.close(() => {
      console.log('\nZenStack proxy server closed')
    })
    await prisma.$disconnect()
    process.exit(0)
  })
}
