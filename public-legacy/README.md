# Retained Apache static files

These five files are byte-for-byte copies of tracked files from `gdgeek/game`
revision `74cae4cdb0a5807dd32b97dd90d56ceff3f5c52b`. `manifest.json` records each
original path, byte length and SHA-256. The source Dockerfile also copies
`files/api/web/robots.txt` over `api/web/robots.txt`; those two tracked files
have identical bytes at this revision.

`legacyStaticMiddleware()` serves only the five exact paths listed in its
allowlist, for GET and HEAD. The manifest, this note, directories, PHP files,
generated assets and dotfiles are never published. Mount it at the server root
before API routing and copy this directory to `/app/public-legacy` in the image.
It resolves the directory relative to the module, independent of the process
working directory.

The two text verification files are retained for existing domain validation;
their contents must not be regenerated or replaced. The tests verify the pinned
manifest hashes and HTTP response bytes, MIME types, HEAD responses and closed
paths. They do not establish matching Apache file-modification dates, ETags,
conditional/range response headers or non-GET/HEAD method behavior.
