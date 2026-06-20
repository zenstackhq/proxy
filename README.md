# ZenStack Proxy CLI

A CLI tool to run an Express server with ZenStack proxy integration directly from the command line.

## Installation

```bash
npm install @zenstackhq/proxy
```

## Usage

### Start the Server

```bash
zenstack-proxy [options]
```

### Options

- `-z, --zenstack <path>` Path to ZenStack generated folder
- `-p, --port <number>` Port number for the server (default: `8008`)
- `-s, --schema <path>` - Path to ZModel schema file (default: "schema.zmodel")
- `-d, --datasource-url <url>` Datasource URL (overrides schema configuration)
- `--studioAuthKey <key>` Authentication key from ZenStack Studio. When set, the proxy will only accept requests signed by your Studio project.
- `-l, --log <level...>` Query log levels (e.g., query, info, warn, error)
- `--signature-tolerance-secs <number>` Time tolerance in seconds for signed requests (default: `60`)

### Examples

#### Basic Usage

Start a server with default settings (searches for ZenStack output automatically):

```bash
zenstack-proxy
```

#### Specify ZenStack schema and generated output

```bash
zenstack-proxy -s ./schema/schema.zmodel -z ./generated/zenstack
```

#### Custom Port

```bash
zenstack-proxy -p 8888
```

#### Enable signed requests

```bash
zenstack-proxy --studioAuthKey "MCowBQYDK2VwAyEAFSJV7wjdFuDz2CqYX7hGnITQvcmJYy7OJQq2Cy2Eiqs="
```

When `--studioAuthKey` is provided, every incoming request must include an `X-ZenStack-Signature` header in the format `t=<unix timestamp>,v1=<base64url signature>`.
The signed message format matches ZenStack Studio: `payload + timestamp [+ authorizationToken]`.

- For `GET` and `DELETE` requests, `payload` is the raw query string without the leading `?`.
- For body-based requests, `payload` is the exact JSON request body string.
- For requests without query params or a request body, `payload` is an empty string.
- If an `Authorization: Bearer <token>` header is present, append `<token>` to the signed message.

## Server Endpoints

The server provides the following endpoints:

### ZenStack Model API

- `POST /api/model/:model/:operation` - All ZenStack operations (find, create, update, delete, etc.)

The ZenStack middleware handles all CRUD operations for your models.

### Metadata

- `GET /api/schema` - Get complete schema metadata (models + enums)

## License

MIT
