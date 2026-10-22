import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('enlarged cards expose a safe text view for effects and card details', async () => {
    const [html, appSource, styles] = await Promise.all([
        readFile(new URL('index.html', root), 'utf8'),
        readFile(new URL('app.js', root), 'utf8'),
        readFile(new URL('style.css', root), 'utf8')
    ]);

    assert.match(html, /id="lightbox-text-toggle-btn"/);
    assert.match(html, /id="lightbox-effect-text"/);
    assert.match(html, /id="lightbox-trigger-text"/);
    assert.match(html, /id="lightbox-features-text"/);
    assert.match(appSource, /function updateLightboxCardText\(card\)/);
    assert.match(appSource, /lightboxEffectText\.textContent/);
    assert.match(appSource, /lightboxTriggerText\.textContent/);
    assert.match(appSource, /setAttribute\('aria-pressed'/);
    assert.doesNotMatch(appSource, /lightboxEffectText\.innerHTML/);
    assert.match(styles, /\.lightbox-overlay\.show-card-text \.lightbox-image/);
    assert.match(styles, /\.lightbox-card-text-row dd/);
});
