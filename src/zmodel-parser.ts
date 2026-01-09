import * as fs from 'fs'
import * as path from 'path'
import { CliError } from './cli-error'

type DatabaseProvider = 'sqlite' | 'postgresql' | 'mysql'

export interface DatasourceConfig {
  provider: DatabaseProvider
  url: string
}

export interface GeneratorConfig {
  provider: string
  output?: string
  engineType?: string
}

export interface ZModelConfig {
  datasource: DatasourceConfig
  generator: GeneratorConfig
  prismaSchemaPath?: string
}

/**
 * Remove comments from zmodel schema content
 */
function removeComments(content: string): string {
  // Remove multi-line comments (/** ... */)
  content = content.replace(/\/\*[\s\S]*?\*\//g, '')
  // Remove single-line comments (//...)
  content = content.replace(/^\s*\/\/.*$/gm, '')
  return content
}

/**
 * Try to load datasource URL from prisma.config.ts
 */
function loadPrismaConfig(schemaDir: string): string | null {
  const configPath = path.join(schemaDir, 'prisma.config.ts')

  if (!fs.existsSync(configPath)) {
    return null
  }

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8')

    // Create a sandbox environment to evaluate the config
    const env = (varName: string) => {
      const value = process.env[varName]
      if (!value) {
        throw new CliError(`Environment variable ${varName} is not set`)
      }
      return value
    }

    // Extract the export default statement and the config object
    // Handle: export default defineConfig({ ... })
    const defineConfigMatch = configContent.match(
      /export\s+default\s+defineConfig\s*\(\s*(\{[\s\S]*?\})\s*\)/
    )

    // Handle: export default { ... }
    const directExportMatch = configContent.match(/export\s+default\s+(\{[\s\S]*?\})(?:\s*;|\s*$)/m)

    let configObjectStr = defineConfigMatch?.[1] || directExportMatch?.[1]

    if (!configObjectStr) {
      return null
    }

    // Use Function constructor to safely evaluate the object literal
    // This is safer than eval as it doesn't have access to the local scope
    try {
      const configFn = new Function('env', `return ${configObjectStr}`)
      const config = configFn(env)

      return config?.datasource?.url || null
    } catch (evalError) {
      console.warn(`Warning: Could not evaluate config object: ${evalError}`)
      return null
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Environment variable')) {
      throw error
    }
    console.warn(`Warning: Failed to parse prisma.config.ts: ${error}`)
    return null
  }
}

/**
 * Parse datasource configuration from zmodel schema
 */
function parseDatasource(
  content: string,
  schemaDir: string,
  datasourceUrlOverride?: string
): DatasourceConfig {
  // Match datasource block
  const datasourceMatch = content.match(/datasource\s+\w+\s*\{([^}]+)\}/s)
  if (!datasourceMatch) {
    throw new CliError('No datasource block found in zmodel schema')
  }

  const datasourceBlock = datasourceMatch[1]

  // Extract provider
  const providerMatch = datasourceBlock.match(/provider\s*=\s*['"]([^'"]+)['"]/)
  if (!providerMatch) {
    throw new CliError('No provider found in datasource block')
  }
  const provider = providerMatch[1] as DatabaseProvider

  // If CLI override is provided, use it
  if (datasourceUrlOverride) {
    return { provider, url: datasourceUrlOverride }
  }

  // Extract url from schema
  let urlMatch = datasourceBlock.match(/url\s*=\s*['"]([^'"]+)['"]/)
  let url: string | null = null

  if (urlMatch) {
    url = urlMatch[1]
  } else {
    // Try to match env("xxx")
    const envMatch = datasourceBlock.match(/url\s*=\s*env\(\s*['"]([^'"]+)['"]\s*\)/)
    if (envMatch) {
      const envVar = envMatch[1]
      const envValue = process.env[envVar]
      if (envValue) {
        url = envValue
      }
    }
  }

  // If no URL found in schema, try prisma.config.ts (Prisma 7)
  if (!url) {
    url = loadPrismaConfig(schemaDir)
  }

  // If still no URL found, throw error
  if (!url) {
    throw new CliError(
      'No datasource URL found. For Prisma 7, ensure prisma.config.ts exists with datasource configuration, or provide the URL via --datasource-url option.'
    )
  }

  return { provider, url }
}

/**
 * Parse generator configuration from zmodel schema
 */
function parseGenerator(content: string): GeneratorConfig {
  // Match generator block for prisma client
  const generatorMatch = content.match(/generator\s+\w+\s*\{([^}]+)\}/s)
  if (!generatorMatch) {
    throw new CliError(
      'No generator block found in zmodel schema.\nZenStack V3 is not supported, V3 will have built-in proxy support soon.'
    )
  }

  const generatorBlock = generatorMatch[1]

  // Extract provider
  const providerMatch = generatorBlock.match(/provider\s*=\s*['"]([^'"]+)['"]/)
  if (!providerMatch) {
    throw new CliError('No provider found in generator block')
  }
  const provider = providerMatch[1]

  // Extract output (optional)
  const outputMatch = generatorBlock.match(/output\s*=\s*['"]([^'"]+)['"]/)
  const output = outputMatch ? outputMatch[1] : undefined

  // Extract engineType (optional)
  const engineTypeMatch = generatorBlock.match(/engineType\s*=\s*['"]([^'"]+)['"]/)
  const engineType = engineTypeMatch ? engineTypeMatch[1] : undefined

  return { provider, output, engineType }
}

/**
 * Parse plugin block for '@core/prisma' provider and extract output
 */
export function parsePrismaSchemaPath(content: string): string | undefined {
  const match = content.match(
    /plugin\s+\w+\s*\{[^}]*provider\s*=\s*['"]@core\/prisma['"][^}]*output\s*=\s*['"]([^'"]+)['"][^}]*\}/s
  )
  return match ? match[1] : undefined
}

/**
 * Parse zmodel schema file and extract datasource and generator configuration
 */
export function parseZModelSchema(
  zmodelPath: string,
  datasourceUrlOverride?: string
): ZModelConfig {
  const content = removeComments(fs.readFileSync(zmodelPath, 'utf-8'))
  const schemaDir = path.dirname(zmodelPath)

  const datasource = parseDatasource(content, schemaDir, datasourceUrlOverride)
  const generator = parseGenerator(content)
  const prismaSchemaPath = parsePrismaSchemaPath(content)

  return {
    datasource,
    generator,
    prismaSchemaPath,
  }
}
