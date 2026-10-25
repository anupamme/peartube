import Foundation
import Darwin

@MainActor
final class BonjourHost: NSObject {
    var send: (([String: Any]) -> Void)?
    private var operations: [Int: BonjourOperation] = [:]

    func handle(_ message: [String: Any]) {
        guard let id = message["handle"] as? Int, let operation = message["operation"] as? String else { return }
        if operation == "stop" { operations.removeValue(forKey: id)?.stop(); return }
        guard let record = message["record"] as? [String: Any], let type = record["type"] as? String,
              let proto = record["protocol"] as? String,
              ["_hyperdht-mdns._udp.", "_peartube-cast._tcp."].contains("_\(type)._\(proto).") else {
            send?(["event": "bonjour", "handle": id, "action": "error", "error": "Unsupported Bonjour service type"])
            return
        }
        operations.removeValue(forKey: id)?.stop()
        let instance = BonjourOperation(id: id, emit: { [weak self] in self?.send?($0) })
        operations[id] = instance
        instance.start(operation, record: record, type: "_\(type)._\(proto).")
    }

    func refreshBrowsers() {
        for instance in operations.values { instance.refreshBrowser() }
    }

    func close() {
        for instance in operations.values { instance.stop() }
        operations.removeAll()
    }
}

@MainActor
private final class BonjourOperation: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    let id: Int
    let emit: ([String: Any]) -> Void
    var browser: NetServiceBrowser?
    private var browseType: String?
    var publication: NetService?
    var services: [String: NetService] = [:]
    var records: [String: [String: Any]] = [:]

    init(id: Int, emit: @escaping ([String: Any]) -> Void) { self.id = id; self.emit = emit }

    func start(_ operation: String, record: [String: Any], type: String) {
        if operation == "browse" {
            browseType = type
            refreshBrowser()
        } else if operation == "publish", let name = record["name"] as? String, let port = record["port"] as? Int, (1...65535).contains(port) {
            let service = NetService(domain: "local.", type: type, name: name, port: Int32(port))
            publication = service
            service.delegate = self
            let txt = (record["txt"] as? [String: Any] ?? [:]).mapValues { Data(String(describing: $0).utf8) }
            service.setTXTRecord(NetService.data(fromTXTRecord: txt))
            service.publish()
        } else { fail("Invalid Bonjour operation or service record") }
    }

    func refreshBrowser() {
        guard let type = browseType else { return }
        for record in records.values { emit(["event": "bonjour", "handle": id, "action": "down", "service": record]) }
        stopBrowser()
        let browser = NetServiceBrowser()
        self.browser = browser
        browser.delegate = self
        browser.searchForServices(ofType: type, inDomain: "local.")
    }

    private func stopBrowser() {
        browser?.delegate = nil; browser?.stop(); browser = nil
        for service in services.values { service.delegate = nil; service.stopMonitoring(); service.stop() }
        services.removeAll(); records.removeAll()
    }

    func stop() {
        browseType = nil
        stopBrowser()
        publication?.delegate = nil; publication?.stop(); publication = nil
    }

    func key(_ service: NetService) -> String { "\(service.name)\u{0}\(service.type)\u{0}\(service.domain)" }
    func fail(_ text: String) { emit(["event": "bonjour", "handle": id, "action": "error", "error": text]) }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        services[key(service)] = service
        service.delegate = self
        service.resolve(withTimeout: 10)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        let name = key(service)
        if let record = records.removeValue(forKey: name) { emit(["event": "bonjour", "handle": id, "action": "down", "service": record]) }
        let found = services.removeValue(forKey: name)
        found?.stopMonitoring(); found?.stop(); found?.delegate = nil
    }

    func netServiceDidResolveAddress(_ sender: NetService) { report(sender); sender.startMonitoring() }
    func netService(_ sender: NetService, didUpdateTXTRecord data: Data) { report(sender, txtData: data) }

    func report(_ service: NetService, txtData: Data? = nil) {
        let txt = NetService.dictionary(fromTXTRecord: txtData ?? service.txtRecordData() ?? Data()).mapValues { String(decoding: $0, as: UTF8.self) }
        let addresses: [String] = (service.addresses ?? []).compactMap { data in
            data.withUnsafeBytes { raw -> String? in
                guard let base = raw.baseAddress, raw.count >= MemoryLayout<sockaddr>.size else { return nil }
                let socket = base.assumingMemoryBound(to: sockaddr.self)
                guard Int32(socket.pointee.sa_family) == AF_INET else { return nil }
                var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                guard getnameinfo(socket, socklen_t(data.count), &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
                return String(cString: name)
            }
        }
        let parts = service.type.split(separator: ".").map { String($0.dropFirst()) }
        guard parts.count >= 2 else { return }
        let record: [String: Any] = ["name": service.name, "type": parts[0], "protocol": parts[1], "port": service.port, "txt": txt, "addresses": addresses, "host": service.hostName ?? ""]
        records[key(service)] = record
        emit(["event": "bonjour", "handle": id, "action": "up", "service": record])
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) { fail("Bonjour browse failed: \(errorDict)") }
    func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) { fail("Bonjour publish failed: \(errorDict)") }
    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) { fail("Bonjour resolve failed: \(errorDict)") }
}
