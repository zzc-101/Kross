import { describe, expect, it } from 'vitest';

import {
  applyMultimodalReadPolicy,
  dropRemoteUrlImages,
  hasRemoteUrlImages,
  parseImageParts,
  resolveRemoteImages,
  toPiImageContent,
  UNSUPPORTED_IMAGE_NOTE
} from './multimodal';

describe('multimodal helpers', () => {
  it('parses url and base64 parts and skips unknown items', () => {
    expect(
      parseImageParts([
        { kind: 'url', url: ' https://cdn.example/a.png ', mimeType: 'image/png' },
        { kind: 'base64', data: 'abc', mimeType: 'image/jpeg' },
        { kind: 'workspace', path: ' uploads/shot.png ', mimeType: 'image/png' },
        { kind: 'url', url: '' },
        { kind: 'file', path: 'x' },
        null
      ])
    ).toEqual([
      { kind: 'url', url: 'https://cdn.example/a.png', mimeType: 'image/png' },
      { kind: 'base64', data: 'abc', mimeType: 'image/jpeg' },
      { kind: 'workspace', path: 'uploads/shot.png', mimeType: 'image/png' }
    ]);
    });

  it('strips images and appends a notice when multimodalRead is false', () => {
    const [message] = applyMultimodalReadPolicy(
      [
        {
          role: 'user',
          content: '看这张图',
          images: [{ kind: 'url', url: 'https://cdn.example/a.png' }]
        }
      ],
      false
    );
    expect(message).toEqual({
      role: 'user',
      content: `看这张图\n${UNSUPPORTED_IMAGE_NOTE(1)}`
    });
  });

  it('keeps user images when multimodalRead is true', () => {
    const images = [{ kind: 'url' as const, url: 'https://cdn.example/a.png' }];
    const [message] = applyMultimodalReadPolicy(
      [{ role: 'user', content: '看这张图', images }],
      true
    );
    expect(message).toMatchObject({ role: 'user', images });
  });

  it('detects remote urls and converts data urls for pi-ai', () => {
    expect(
      hasRemoteUrlImages([
        {
          role: 'user',
          content: 'x',
          images: [{ kind: 'url', url: 'https://cdn.example/a.png' }]
        }
      ])
    ).toBe(true);
    expect(
      toPiImageContent({
        kind: 'url',
        url: 'data:image/png;base64,abc'
      })
    ).toEqual({ type: 'image', data: 'abc', mimeType: 'image/png' });
    const [dropped] = dropRemoteUrlImages([
      {
        role: 'user',
        content: 'x',
        images: [
          { kind: 'url', url: 'https://cdn.example/a.png' },
          { kind: 'base64', data: 'abc', mimeType: 'image/png' }
        ]
      }
    ]);
    expect(dropped).toMatchObject({
      role: 'user',
      content: `x\n${UNSUPPORTED_IMAGE_NOTE(1)}`,
      images: [{ kind: 'base64', data: 'abc', mimeType: 'image/png' }]
    });
  });

  it('downloads remote urls into base64 for pi-ai', async () => {
    const png = Uint8Array.from([1, 2, 3]);
    const [message] = await resolveRemoteImages(
      [
        {
          role: 'user',
          content: 'x',
          images: [{ kind: 'url', url: 'https://cdn.example/a.png' }]
        }
      ],
      async () =>
        new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png' }
        })
    );
    expect(message).toMatchObject({
      role: 'user',
      images: [
        {
          kind: 'base64',
          data: Buffer.from(png).toString('base64'),
          mimeType: 'image/png'
        }
      ]
    });
  });

  it('leaves failed remote urls for dropRemoteUrlImages', async () => {
    const [resolved] = await resolveRemoteImages(
      [
        {
          role: 'user',
          content: 'x',
          images: [{ kind: 'url', url: 'https://cdn.example/a.png' }]
        }
      ],
      async () => new Response('missing', { status: 404 })
    );
    expect(resolved).toMatchObject({
      images: [{ kind: 'url', url: 'https://cdn.example/a.png' }]
    });
  });
});
