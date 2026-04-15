import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

export async function GET() {
  const filePath = path.join(process.cwd(), 'data', 'showup_analysis.json')
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({})
  }
  const raw = fs.readFileSync(filePath, 'utf-8')
  return NextResponse.json(JSON.parse(raw))
}
