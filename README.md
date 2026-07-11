# KeyFont

KeyFont is an open-source part of the KeyPDF engine, browser-based font inspection and conversion toolkit. It supports TrueType, OpenType/CFF, WOFF, WOFF2, Type 1, and SVG font workflows. Font processing happens locally in the browser.

## Run locally

The HTML pages load the readable files in `src/` directly, so any static HTTP server can serve the project immediately wihtout any setup.

```sh
npx serve .
```

or via python

```sh
python -m http.server 
```


## Source layout

- `src/` contains the application, format parsers, conversion code, UI, and browser-worker source.
- `src/vendor/` contains readable third-party browser code required for WOFF2 made by https://github.com/kekee000/fonteditor-core
- `index.html` is the font viewer, editor, and single-font utility.
- `converter.html` converts files, ZIP archives, or folders to a selected target format.


## License

KeyFont's project code is available under the [MIT License](LICENSE). Third-party components remain under their respective licenses.
