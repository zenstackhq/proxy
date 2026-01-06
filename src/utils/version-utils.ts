import * as fs from 'fs'
import * as path from 'path'

/* eslint-disable @typescript-eslint/no-var-requires */
export function getVersion(): string | undefined {
  try {
    return require('../package.json').version
  } catch {
    try {
      // dev environment
      return require('../../package.json').version
    } catch {
      return undefined
    }
  }
}

export function getNodeModulesFolder(startPath?: string): string | undefined {
  startPath = startPath ?? process.cwd()
  if (startPath.endsWith('node_modules')) {
    return startPath
  } else if (fs.existsSync(path.join(startPath, 'node_modules'))) {
    return path.join(startPath, 'node_modules')
  } else {
    const parsed = path.parse(startPath)
    if (parsed.root === startPath) {
      return undefined
    } else {
      const parent = path.join(startPath, '..')
      return getNodeModulesFolder(parent)
    }
  }
}

export function getZenStackVersion(): string | undefined {
  try {
    return require('zenstack').version
  } catch {
    try {
      // runtime
      return require('@zenstackhq/runtime/package.json').version
    } catch {
      return undefined
    }
  }
}

/**
 * Gets the installed Prisma's version
 */
export function getPrismaVersion(): string | undefined {
  try {
    return require('@prisma/client/package.json').version
  } catch {
    try {
      return require('prisma/package.json').version
    } catch {
      return undefined
    }
  }
}
