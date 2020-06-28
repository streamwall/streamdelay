# Streamdelay

![A pixelated stream filtered using streamdelay](screenshot.png)

Streamdelay enables streams to have ["broadcast delay"](https://en.wikipedia.org/wiki/Broadcast_delay) for content redaction/filtering. Stream upload is delayed by a customizable duration, allowing a pixelization and audio blocking filter to be applied ahead of unacceptable content being broadcast.

Streamdelay accepts an input stream using the [SRT protocol](https://www.haivision.com/products/srt-secure-reliable-transport/) (supported by OBS and ffmpeg), and can output to either an SRT or RTMP endpoint (such as twitch.tv or restream.io).

A UI is currently not provided. The `streamdelay` package is designed to run as a local service, controlled via its built-in API server. This is meant to be integrated into a larger stream management dashboard, such as [`streamwall`](https://github.com/chromakode/streamwall).

## Setup

### Binaries

Binaries may be available via the [releases page](https://github.com/chromakode/streamdelay/releases). You will need to [install the GStreamer runtime](https://gstreamer.freedesktop.org/download/) for your platform.

### Source

1. Ensure you have the buildchain for your platform installed necessary to [build binary node modules using node-gyp](https://github.com/nodejs/node-gyp#installation).
1. Install [GStreamer](https://gstreamer.freedesktop.org/download/). You will need both the runtime and development headers installed.
1. Run `npm install`. This will install dependencies and build the `node-gstreamer-superficial` library.

## Usage

### Starting Streamdelay

1. Copy `example.config.json` to `config.json` and customize to suit your needs.
1. Configure your streaming software to output to the SRT endpoint specified in `"srtInUri"`.
1. Run (binary) `streamdelay --config=config.json` or (development) `npm start -- --config=config.json`.
1. Start streaming.

## HTTP API

Streamdelay runs an HTTP server on the hostname and port you configure.

### Authentication

Requests must either contain:

- a `Streamdelay-API-Key` header equal to the `apiKey` value configured
- a `?key=API_KEY` query param equal to the `apiKey` value configured

All responses are `Content-Type: application/json`.

### Get current state

```
GET /state
```

returns:

```
{
  censored: bool,
  status: {... full state object ...}
}
```

The `status` object can be matched using [`xstate`'s `State.from` constructor](https://xstate.js.org/api/classes/state.html#from):

```js
// Check if the stream is waiting for a connection
State.from(status).matches('stream.running.waiting')

// Check if the stream is connected and rolling
State.from(status).matches('stream.running.started')

// Check if we're in the process of deactivating the censorship mode
State.from(status).matches('censorship.censored.deactivating')
```

### Set state

Set the stream state to censored (redacted) or not. When transitioning from censored to uncensored state, Streamdelay will wait the configured `delaySeconds` before turning off the censored state. This helps prevent early release of the censored mode before the delayed content has been broadcast.

```
PATCH /state
Content-Type: application/json
{censored: false} or {censored: true}
```

returns: same as `/status`

## Websocket API

```
GET /ws?key=API_KEY
Upgrade: websocket
```

Upon initial connection, the current state will be sent in JSON format. It will be sent again whenever the state changes.

Sending a JSON message has the same behavior as `PATCH /state`.
