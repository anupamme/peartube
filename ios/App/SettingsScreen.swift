import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct SettingsScreen: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var tracker: String
    @State private var sources: String
    @State private var relay: String
    @State private var bootstrap: String
    @State private var lan: Bool
    @State private var privateRouting: Bool
    @State private var importer = false
    @State private var scanner = false
    @State private var link = ""
    @State private var share: String?
    init(model: AppModel) {
        self.model = model
        _tracker = State(initialValue: model.settings.tracker)
        _sources = State(initialValue: model.settings.sources.map(\.uri).joined(separator: "\n"))
        _relay = State(initialValue: model.settings.relayThrough.joined(separator: "\n"))
        _bootstrap = State(initialValue: model.settings.bootstrap.joined(separator: "\n"))
        _lan = State(initialValue: model.settings.lanDiscovery)
        _privateRouting = State(initialValue: model.settings.privateRouting)
    }
    var body: some View {
        NavigationStack {
            Form {
                if !model.settings.configured {
                    Section {
                        Text("A little cinema, anywhere.").font(.title2.bold())
                        Text("Follow a channel or join a tracker to find media. You can save settings and add sources later.").foregroundStyle(.secondary)
                    }
                }
                if let error = model.error {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("settings.error"); Button("Dismiss Error") { model.error = nil } }
                }
                Section("Open a Link or Key") {
                    TextField("peartube://… or 64-hex key", text: $link).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("settings.uri")
                    HStack {
                        Button("Open Link") { Task { await model.openURI(link); syncFields() } }.disabled(link.isEmpty || model.busy).accessibilityIdentifier("settings.openURI")
                        Spacer()
                        Button { scanner = true } label: { Label("Scan QR", systemImage: "qrcode.viewfinder") }.accessibilityIdentifier("settings.scan")
                    }
                }
                Section {
                    TextField("Primary tracker key or URI", text: $tracker, axis: .vertical).lineLimit(1...3).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("settings.tracker")
                    TextField("Channels / trackers, one per line", text: $sources, axis: .vertical).lineLimit(3...8).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("settings.sources")
                } header: { Text("Subscriptions") } footer: { Text("Use 64-hex keys or peartube://channel/<key>?name=Alias and peartube://tracker/<key> links. Channel keys are the default in the sources list.") }
                if !model.sources.isEmpty || !model.discovered.isEmpty {
                    Section("Channels & Sources") {
                        ForEach(model.sources, id: \.selfKey) { source in
                            SourceRow(source: source, canRemove: !source.flag("writable") || source.flag("primary"), share: { share = SourceSpec(source).uri }, remove: {
                                Task { await model.removeSource(source.string("key")); syncFields() }
                            })
                        }
                        ForEach(model.discovered, id: \.selfKey) { found in
                            HStack {
                                VStack(alignment: .leading) { Text(found.string("title")); Text("Discovered via \(found.string("via"))").font(.caption).foregroundStyle(.secondary) }
                                Spacer()
                                Button("Follow") { Task { await model.addSource(SourceSpec(key: found.string("key"), kind: found.string("kind"), alias: found.string("title"))); syncFields() } }.accessibilityIdentifier("sources.follow.\(found.string("key"))")
                            }
                        }
                    }
                }
                Section {
                    TextField("Blind relay public keys", text: $relay, axis: .vertical).lineLimit(2...5).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("settings.relay")
                    TextField("Bootstrap host:port, one per line", text: $bootstrap, axis: .vertical).lineLimit(2...5).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("settings.bootstrap")
                    Toggle("LAN Discovery", isOn: $lan).accessibilityIdentifier("settings.lan")
                    Toggle("Private Routing", isOn: $privateRouting).accessibilityIdentifier("settings.private")
                } header: { Text("Network") } footer: { Text("Empty relay and bootstrap lists use the normal network defaults. Private routing uses the core's private path; route-by-route traffic is shown under Under the Hood.") }
                Section("MIDI SoundFont") {
                    Text(model.soundfontPresent ? "A local SoundFont 2 bank is selected." : "No bank selected. MIDI playback requires your own SoundFont.").foregroundStyle(.secondary)
                    Button(model.soundfontBusy ? "Importing…" : "Import SoundFont (.sf2)") { importer = true }.disabled(model.soundfontBusy).accessibilityIdentifier("settings.soundfont.import")
                    if model.soundfontPresent { Button("Remove SoundFont", role: .destructive) { model.removeSoundfont() }.accessibilityIdentifier("settings.soundfont.remove") }
                    Text("Files must have a complete RIFF/sfbk header and matching length, and be no larger than 256 MiB. Banks stay private on this device.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Storage & History") {
                    LabeledContent("Cached Media", value: bytes(model.status.number("cachedBytes")))
                    Button("Clear Downloaded Cache", role: .destructive) { Task { await model.clearCache() } }.accessibilityIdentifier("settings.cache.clear")
                    Button("Clear Watch History", role: .destructive) { model.clearHistory() }.accessibilityIdentifier("settings.history.clear")
                }
                Section {
                    Button {
                        do {
                            let next = try Settings.parse(tracker: tracker, sources: sources, relays: relay, bootstrap: bootstrap, lan: lan, privateRouting: privateRouting)
                            Task { await model.save(next) }
                        } catch { model.error = error.localizedDescription }
                    } label: { HStack { Spacer(); if model.busy { ProgressView() }; Text("Save & Connect").bold(); Spacer() } }
                        .disabled(model.busy).accessibilityIdentifier("settings.save")
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("settings.close") } }
        }
        .fileImporter(isPresented: $importer, allowedContentTypes: [UTType(filenameExtension: "sf2") ?? .data], allowsMultipleSelection: false) { result in
            switch result { case .success(let urls): if let url = urls.first { Task { await model.importSoundfont(url) } }; case .failure(let error): model.error = error.localizedDescription }
        }
        .sheet(isPresented: $scanner) { QRScanner { uri in scanner = false; Task { await model.openURI(uri); syncFields() } } }
        .sheet(isPresented: Binding(get: { share != nil }, set: { if !$0 { share = nil } })) { if let share { ShareQR(uri: share) } }
    }
    private func syncFields() { tracker = model.settings.tracker; sources = model.settings.sources.map(\.uri).joined(separator: "\n") }
}

struct SourceRow: View {
    let source: [String: Any]
    let canRemove: Bool
    let share: () -> Void
    let remove: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(SourceSpec(source).name).font(.headline)
            Text(source.string("key")).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            HStack {
                Text(source.flag("primary") ? "Primary tracker" : source.flag("writable") ? "Your channel" : source.string("kind").capitalized).font(.caption)
                Spacer()
                Button("Share QR", action: share).accessibilityIdentifier("sources.share.\(source.string("key"))")
                if canRemove { Button("Remove", role: .destructive, action: remove).accessibilityIdentifier("sources.remove.\(source.string("key"))") }
            }
        }.padding(.vertical, 4)
    }
}

@MainActor
struct DiagnosticsScreen: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var share: String?
    var body: some View {
        NavigationStack {
            List {
                Section("Peer Engine") {
                    metric("Public Peers", "peers"); metric("LAN Peers", "lanPeers")
                    LabeledContent("LAN", value: model.status.string("lan").isEmpty ? "Off / unavailable" : model.status.string("lan"))
                    LabeledContent("Download", value: "\(bytes(model.status.number("downBps")))/s")
                    LabeledContent("Upload", value: "\(bytes(model.status.number("upBps")))/s")
                    LabeledContent("Received", value: bytes(model.status.number("rxBytes")))
                    LabeledContent("Sent", value: bytes(model.status.number("txBytes")))
                    LabeledContent("Blob Storage", value: bytes(model.status.number("blobBytes")))
                    LabeledContent("Downloaded Cache", value: bytes(model.status.number("cachedBytes")))
                    metric("Inflight Blocks", "inflightBlocks"); metric("RTT (ms)", "rtt"); metric("Retransmits", "retransmits")
                }
                ForEach(["private", "public", "lan"], id: \.self) { name in
                    let route = model.status.object("routes").object(name)
                    Section(name == "private" ? "Private Route" : name == "public" ? "Public DHT Route" : "LAN Route") {
                        LabeledContent("Peers", value: route["peers"] == nil ? "—" : String(Int(route.number("peers"))))
                        LabeledContent("Received", value: route["rxBytes"] == nil ? "—" : bytes(route.number("rxBytes")))
                        LabeledContent("Sent", value: route["txBytes"] == nil ? "—" : bytes(route.number("txBytes")))
                        LabeledContent("Download", value: route["downBps"] == nil ? "—" : "\(bytes(route.number("downBps")))/s")
                        LabeledContent("Upload", value: route["upBps"] == nil ? "—" : "\(bytes(route.number("upBps")))/s")
                    }.accessibilityIdentifier("hood.route.\(name)")
                }
                Section("Reciprocity") {
                    let r = model.status.object("reciprocity")
                    LabeledContent("Tier", value: r.string("tier"))
                    LabeledContent("Seeded", value: bytes(r.number("seededBytes")))
                    LabeledContent("Contributing Peers", value: String(Int(r.number("contributingPeers"))))
                    LabeledContent("Ratio", value: String(format: "%.3f", r.number("ratio")))
                    LabeledContent("Inflight Maximum", value: String(Int(r.number("inflightMax"))))
                }
                Section("Channels & Sources") {
                    ForEach(model.sources, id: \.selfKey) { source in SourceRow(source: source, canRemove: !source.flag("writable") || source.flag("primary"), share: { share = SourceSpec(source).uri }, remove: { Task { await model.removeSource(source.string("key")) } }) }
                    ForEach(model.discovered, id: \.selfKey) { source in
                        HStack {
                            VStack(alignment: .leading) { Text(source.string("title")); Text(source.string("via")).font(.caption).foregroundStyle(.secondary) }
                            Spacer()
                            Button("Follow") { Task { await model.addSource(SourceSpec(key: source.string("key"), kind: source.string("kind"), alias: source.string("title"))) } }.accessibilityIdentifier("sources.follow.\(source.string("key"))")
                        }
                    }
                    if !model.status.string("channel").isEmpty { Button("Share My Channel") { share = "peartube://channel/\(model.status.string("channel"))" }.accessibilityIdentifier("hood.shareChannel") }
                    Button("Add Channel or Link") { dismiss(); model.showSettings = true }.accessibilityIdentifier("hood.addSource")
                }
                Section("Storage") { Button("Clear Downloaded Cache", role: .destructive) { Task { await model.clearCache() } }.accessibilityIdentifier("hood.cache.clear") }
                Section("Engine Room · Actual Worker State") { Text(jsonText(model.status)).font(.caption.monospaced()).textSelection(.enabled).accessibilityIdentifier("hood.rawState") }
            }.navigationTitle("Under the Hood").toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Refresh") { Task { await model.refresh() } }.accessibilityIdentifier("hood.refresh") }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
            .sheet(isPresented: Binding(get: { share != nil }, set: { if !$0 { share = nil } })) { if let share { ShareQR(uri: share) } }
    }
    private func metric(_ label: String, _ field: String) -> some View { LabeledContent(label, value: model.status[field] == nil ? "—" : String(Int(model.status.number(field)))) }
}
