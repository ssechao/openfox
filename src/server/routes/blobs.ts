import type { Express, Request, Response } from 'express'
import { isBlobHash } from '../../shared/blob.js'
import { BlobCorruptError, BlobMissingError, getBlobStore } from '../events/blob-store.js'

export function registerBlobRoutes(app: Express): void {
  app.get('/api/blobs/:hash', (req: Request, res: Response) => {
    const hash = String(req.params['hash'] ?? '')
    if (!isBlobHash(hash)) {
      res.status(400).json({ error: 'Invalid blob hash' })
      return
    }
    try {
      const blob = getBlobStore().get(hash)
      res.setHeader('Content-Type', blob.mime)
      res.setHeader('Content-Length', String(blob.bytes.length))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      res.end(blob.bytes)
    } catch (error) {
      if (error instanceof BlobMissingError) {
        res.status(404).json({ error: 'Blob not found' })
        return
      }
      if (error instanceof BlobCorruptError) {
        res.status(500).json({ error: 'Blob corrupt' })
        return
      }
      throw error
    }
  })
}
