import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('Extension manifest', () => {
    test('registers the Mercury language so activation can fire', () => {
        const manifestPath = path.resolve(__dirname, '../../../package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        assert.ok(Array.isArray(manifest.activationEvents), 'activationEvents should exist');
        assert.ok(
            manifest.activationEvents.includes('onLanguage:mercury'),
            'expected activation event onLanguage:mercury'
        );

        const languages = manifest.contributes?.languages ?? [];
        assert.ok(
            languages.some((language: any) =>
                language.id === 'mercury' &&
                Array.isArray(language.extensions) &&
                language.extensions.includes('.m')
            ),
            'expected Mercury language to be registered for .m files'
        );
    });
});
