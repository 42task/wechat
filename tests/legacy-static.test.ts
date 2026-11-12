import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { legacyStaticDirectory, legacyStaticMiddleware, legacyStaticPaths } from '../src/core/legacy-static';

interface ManifestFile { path: string; sourcePath: string; sha256: string; bytes: number; }
const manifest = JSON.parse(readFileSync(resolve(legacyStaticDirectory(), 'manifest.json'), 'utf8')) as {
  sourceRepository: string; sourceRevision: string; files: ManifestFile[];
};

function server() {
  const app = express();
  app.use(legacyStaticMiddleware());
  app.use((_req, res) => { res.status(404).send('closed'); });
  return supertest(app);
}

function bytes(response: any, done: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => done(null, Buffer.concat(chunks)));
  response.on('error', (error: Error) => done(error));
}

describe('retained source public files', () => {
  it('pins exactly the five tracked files to the audited source revision', () => {
    expect(manifest.sourceRepository).toBe('https://github.com/gdgeek/game');
    expect(manifest.sourceRevision).toBe('74cae4cdb0a5807dd32b97dd90d56ceff3f5c52b');
    expect(manifest.files.map(file => file.path)).toEqual(legacyStaticPaths);
    for (const file of manifest.files) {
      expect(file.sourcePath).toBe(`api/web${file.path}`);
      const data = readFileSync(resolve(legacyStaticDirectory(), `.${file.path}`));
      expect(data.length).toBe(file.bytes);
      expect(createHash('sha256').update(data).digest('hex')).toBe(file.sha256);
    }
  });

  it.each(manifest.files)('serves exact bytes for $path, including with a query', async file => {
    const response = await server().get(`${file.path}?validation=1`).buffer(true).parse(bytes).expect(200);
    expect(response.body).toEqual(readFileSync(resolve(legacyStaticDirectory(), `.${file.path}`)));
    const type = file.path.endsWith('.txt') ? 'text/plain' : file.path.endsWith('.css') ? 'text/css' : 'image/vnd.microsoft.icon';
    expect(response.headers['content-type'].split(';')[0]).toBe(type);
    expect(Number(response.headers['content-length'])).toBe(file.bytes);
  });

  it.each(manifest.files)('supports HEAD without a response body for $path', async file => {
    const response = await server().head(file.path).expect(200);
    expect(response.text).toBeUndefined();
    expect(Number(response.headers['content-length'])).toBe(file.bytes);
  });

  it.each([
    '/', '/css', '/css/', '/manifest.json', '/README.md', '/index.php',
    '/index.php/HyffLvU10s.txt', '/.env', '/.git/config', '/assets/file.js',
    '/hyfflvu10s.txt', '/ROBOTS.TXT', '/CSS/site.css', '/css/Site.css',
    '/%48yffLvU10s.txt', '//robots.txt', '/css//site.css',
    '/%2e%2e/package.json', '/css/%2e%2e/manifest.json',
    '/css/%2e%2e/%2e%2e/.env', '/%252e%252e/.env',
    '/robots.txt%00', '/robots.txt/',
  ])('does not expose unlisted path %s', async path => {
    await server().get(path).expect(404, 'closed');
  });

  it.each(['post', 'put', 'patch', 'delete', 'options'] as const)('does not publish static files for %s', async method => {
    await server()[method]('/robots.txt').expect(404, 'closed');
  });
});
