// #401: the menu-bar (tray) icon — the Vellum MONO GLYPH from the brand mark (brand/assets/icon/
// vellum-glyph-mono.svg). Rendered as a macOS TEMPLATE image so it recolors to match the menu bar
// (light/dark, active/inactive) automatically.
//
// The PNGs are embedded as base64 data URLs (16px @1x + 32px @2x) rather than loaded from disk on
// purpose: the tray lives in the MAIN process, which Vite bundles and electron-forge packs into
// app.asar — a runtime file path would resolve differently in dev vs the packaged app (the classic
// asar-asset gotcha). An embedded data URL is identical in both, needs no asset-copy config, and the
// glyph is tiny (<1 KB each).
import { nativeImage, type NativeImage } from 'electron';

// 16×16 (@1x) and 32×32 (@2x), black strokes + alpha — macOS uses the alpha as the template mask.
const GLYPH_16 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAA0VXHyAAABJ0lEQVQ4EbXSzS5DQRTA8an6eAAiYclL9BXEzke8QHUhoR6GpEib7rFggUdgybq2Nt3UmpT/v+ZO3N6WSPQkv8y5p525M2duCBOMGdY+icz/FGX+fYpndHAGa4UoFSohTFNz8nwcPxh38Yoq3pFiKmVfiZMbWMY2VrAa80VGFx57HLfYxB3msIknPMLFZnGDNtJxsiO46hGWsIV17OABfVRwiSuco4s9vCG4iNu2YU48gG89xEuU1eo8r8HGekOlrAc2alz89Nvg7U60eccYPsI9NRfwCBe4RuEI1AYx3MQNqt+baGNv0UZqInku3IkfjTdh1/cjm+wNtGCeIruFVCBxERu0AO/dI9TQQxW5D4nnkeEWnfzrpzxydiy6VXei3Lbj7/8zfALWJT0SdQEfNAAAAABJRU5ErkJggg==';
const GLYPH_32 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAADJElEQVRYCdWXy0tVURSHbymV0SRoEkURDbLXsGgW9HLgpOidg4YW/gk9FG8N/BMapKAU9QdkVETSpKxJT6ORoqbZO3qjUd93OSuut7ycqzfFH3ycdffZe6+111r7WJnMLFc18cuMaBde3yVoT6tq8DYAvxIGeTo2LTqOl7eg8264m9iONUBJmlPS7ExmO/MvwRI4A1VgIJ+hCSzJEbgGZZfO+0CHLbAQmhMMxIB8Z2nK3hM6H04cZHkuAqVTUQZ0GgxiBAyi1Ayz5G9tY+gV/IR2WABqLpxP0FbzoBWca09MOQhPrvMx0FmcvAJ7H3xK0HZMmYlzMAoRBGbp8uRDYEp1bp2Vpz0AOv+QoH0QIggzYRCufQlmoiR58l5wgw6Ik2PmHL3h2QMXwPeP4T3UQciA28A9+iH1d6Keya+ThVmeUXPMnPNvPK/DCjgJJ2AZdMIPMIhoPjMRjZnqO+HJPZ1Rt0D+ya2zN0Hnq2ADdCWs52lABuENOAwhMxFXtGhPWPMB0LkLXBjag2EzPgEdbYT7MJrQzdMgzMQDMIP2SWg+RiO49wv40xORqjUM3oHFcA9uwxeogKXgZl6tK/AMdsBWiPVu3AU3YS3UQiVcBrPmWm+HazaDzbsFntvRk5EOC/WvscI5RX9bgn5wo8IS7GbMEjyFlWC6TXt+Cdbxezk8BEuwH0KWoAnce1wJ+D1OBjFRE+7lnem8AavBIG4lmHZ74yqMwCEImfqzoPOiTRgL6jE8gQuykH8N7YWvYBA69BqKzdcJ36EOojc8eSOE8wbsVDITveDCDsi/jgZhlnrgIvje21H4IfLkbeAelrYGSpJBDIEbTPQp/sg7O7rsn2L2zMkgbL4xMIjIRAW2HyYdi7ZjypP7d2AUUtWceUUVQXiX2yF6Yi62QYm2suat4NxwHv3A0ORlEMNgObIQmfC6ivLkjeAcb4Jfu7I4Z5+cDKIPdNACOmxOqOIZV20AW+epFHVLM7mXSY+gFnaCgRhEJWyCU+A/So+Cf7D+m46xs/U1gO4EbcdS33PmTkneaVOtYxkEx6ZV1nnG/msWJ63GkNmr36k14jPIwPhJAAAAAElFTkSuQmCC';

/** Build the Vellum menu-bar template image (16@1x + 32@2x). Template = macOS recolors via alpha. */
export function buildTrayImage(): NativeImage {
  const img = nativeImage.createFromDataURL(GLYPH_16);
  img.addRepresentation({ scaleFactor: 2, dataURL: GLYPH_32 });
  img.setTemplateImage(true);
  return img;
}
