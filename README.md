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
- `-l, --log <level...>` Query log levels (e.g., query, info, warn, error)

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

## Server Endpoints

The server provides the following endpoints:

### ZenStack Model API

- `POST /api/model/:model/:operation` - All ZenStack operations (find, create, update, delete, etc.)

The ZenStack middleware handles all CRUD operations for your models.

### Metadata

- `GET /api/schema` - Get complete schema metadata (models + enums)

## License

MIT
