class Notifier {
  notifyStarted() {}
  notifyShuttingDown() {}
  setJobStatus(message) {}
  isManaged() { return false }
}

class NoopNotifier extends Notifier {}

class SystemdNotifier extends NoopNotifier {
  constructor(sd_notify_lite) {
    super()
    this.sd_notify_lite = sd_notify_lite
  }
  notifyStarted() {
    this.sd_notify_lite.notifyReady()
  }
  notifyShuttingDown() {
    this.sd_notify_lite.notifyStopping()
  }
  setJobStatus(message) {
    this.sd_notify_lite.notifyStatus(message)
  }
  isManaged() {
    return this.sd_notify_lite.sd_notify.isSystemdManaged()
  }
}

/** @type {Notifier} */
const notifier = (() => {
  // Detect if the library we use to communicate with systemd is installed
  // (sd-notify-lite). If it is not, will throw away all messages to the service
  // manager.
  try {
    const sd_notify_lite = require('sd-notify-lite')
    return new SystemdNotifier(sd_notify_lite)
  } catch {
    return new NoopNotifier()
  }
})()

module.exports = {
  /**
   * Notify the service manager that we have started, and are ready to handle
   * requests.
   */
  notifyStarted() {
    notifier.notifyStarted()
  },

  /** 
   * Notify the service manager that we shutting down, and we would not like any
   * new requests.
   */
  notifyShuttingDown() {
    notifier.notifyShuttingDown()
  },

  /**
   * Set our status in the service manager.
   * @param {string} message The plain text-message to show as this job's
   * current status.
   */
  setJobStatus(message) {
    notifier.setJobStatus(message)
  },

  /**
   * Are we being wrapped by a service managed (such as systemd)
   * 
   * NOTE: Will return false if (optional) library needed to communicate with
   * the service manager is not installed.
   * 
   * @returns bool
   */
  isManaged() {
    return notifier.isManaged();
  }
}
