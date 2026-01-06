import fs from 'node:fs'
import path from 'node:path'

const token = process.env.TELEMETRY_TRACKING_TOKEN

if (!token) {
  console.warn('TELEMETRY_TRACKING_TOKEN is not set.')
} else {
  const filesToProcess = ['dist/constants.js']
  for (const file of filesToProcess) {
    console.log(`Processing ${file} for telemetry token...`)
    const filePath = path.join(__dirname, '..', file)
    const content = fs.readFileSync(filePath, 'utf-8')
    const updatedContent = content.replace('<TELEMETRY_TRACKING_TOKEN>', token)
    fs.writeFileSync(filePath, updatedContent, 'utf-8')
  }
}
