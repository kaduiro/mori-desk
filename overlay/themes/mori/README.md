# Mori theme

Mori is an original sprout mascot created from geometric rectangles in
`scripts/generate-mori-assets.js`. Its shapes are not traced or copied from the
upstream Clawd, Calico, or Cloudling artwork.

The theme metadata and the generated artwork are licensed under the MIT license
in this directory. This license does not change the AGPL license of the desktop
application or the separate license of any upstream assets.

This theme is built into Mori Desk. The upstream theme loader reads built-in
sprite basenames from `assets/svg/`. Regenerate sprites and application icons:

```sh
node scripts/generate-mori-assets.js
node scripts/generate-mori-assets.js --check
node scripts/validate-theme.js themes/mori --assets assets/svg
```

Normal, thinking, running, complete, alert, error and sleep poses use CSS
animation without JavaScript inside SVG. Reduced-motion preferences disable
those animations. Sound, eye tracking, accessories and mini mode are disabled
for this development preview.
