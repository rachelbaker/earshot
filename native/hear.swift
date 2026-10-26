// macOS on-device speech recognition, as a long-running helper: one WAV path
// per line on stdin, one JSON line on stdout per file, `{"text": "..."}` or
// `{"error": "..."}`. Started once and kept running, so the recognizer is warm.
//
// DictationTranscriber rather than SpeechTranscriber: on synthetic test clips
// it was the one that honoured vocabulary hints (README, GitHub, Tailscale
// came out right; SpeechTranscriber wrote "read me", "get hub", "tail scale").
// Neither keeps "um" or "uh", and dictation writes no full stops, which the
// turn taker otherwise uses as signs that a thought has ended.
//
//   hear [hint ...]    words to bias recognition toward
//
// Built by `earshot talk` on first use: swiftc -O -parse-as-library native/hear.swift.
import AVFoundation
import Foundation
import Speech

func reply(_ obj: [String: String]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

@main
struct Hear {
  static func main() async {
    setvbuf(stdout, nil, _IONBF, 0)
    let hints = Array(CommandLine.arguments.dropFirst())
    var found = await DictationTranscriber.supportedLocale(equivalentTo: Locale.current)
    if found == nil { found = await DictationTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
    guard let locale = found else {
      reply(["error": "on-device dictation does not support this language"])
      exit(2)
    }
    func transcriber() -> DictationTranscriber {
      DictationTranscriber(locale: locale, contentHints: [.shortForm], transcriptionOptions: [.punctuation], reportingOptions: [], attributeOptions: [])
    }
    // The language model is a system download the first time; after that it
    // is on the Mac.
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber()]) {
        FileHandle.standardError.write(Data("hear: downloading the on-device speech model…\n".utf8))
        try await request.downloadAndInstall()
      }
    } catch {
      reply(["error": "could not install the on-device speech model: \(error)"])
      exit(2)
    }
    FileHandle.standardError.write(Data("hear: ready (\(locale.identifier))\n".utf8))

    while let line = readLine() {
      let path = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if path.isEmpty { continue }
      do {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let module = transcriber()
        let context = AnalysisContext()
        if !hints.isEmpty { context.contextualStrings[.general] = hints }
        let analyzer = try await SpeechAnalyzer(inputAudioFile: file, modules: [module], analysisContext: context, finishAfterFile: true)
        var text = ""
        for try await r in module.results { text += String(r.text.characters) }
        _ = analyzer
        reply(["text": text.trimmingCharacters(in: .whitespaces)])
      } catch {
        reply(["error": "\(error)"])
      }
    }
  }
}
