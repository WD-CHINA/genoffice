/** The parser protocol stays independent of the HTTP process and transport details. */
export const parentPort = process.send
  ? {
      on(event: 'message', listener: (message: any) => void) {
        process.on(event, listener)
      },
      postMessage(message: unknown) {
        if (!process.connected || !process.send) throw new Error('parser parent disconnected')
        process.send(message as object, (error) => {
          if (error) process.exit(1)
        })
      },
    }
  : null
