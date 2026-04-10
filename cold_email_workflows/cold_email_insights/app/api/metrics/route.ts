import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

export async function GET() {
  const filePath = path.join(process.cwd(), 'data', 'metrics.json')

  if (!fs.existsSync(filePath)) {
    return NextResponse.json(
      { error: 'No data yet. Run python etl.py to generate metrics.' },
      { status: 404 }
    )
  }

  const raw = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(raw)
  return NextResponse.json(data)
}
