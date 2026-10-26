// The microphone, with macOS voice processing (echo cancellation) on, as raw
// samples: 16 kHz mono Float32, little-endian, written to stdout until stdin
// closes or the process is killed.
//
// Voice processing is the reason this is native at all. Measured: with it
// on, the agent's own speech, played by this or any other process, did not
// reach whisper at all; with it off, whisper transcribed it word for word. Real sound in the room still comes through,
// which is the user's voice, and also a television playing nearby.
//
// Built by `earshot talk` on first use: swiftc -O native/ear.swift.
import AVFoundation
import Foundation

setvbuf(stdout, nil, _IONBF, 0)
let engine = AVAudioEngine()
// The mixer has to exist before voice processing is switched on, or the output
// unit fails to initialize (-10875).
_ = engine.mainMixerNode
let input = engine.inputNode
do {
    try input.setVoiceProcessingEnabled(true)
} catch {
    FileHandle.standardError.write("ear: voice processing unavailable: \(error)\n".data(using: .utf8)!)
    exit(2)
}
if #available(macOS 14.0, *) {
    // Not ducking other apps: her music or the room's TV should not drop out
    // every time she speaks.
    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
}

let format = input.outputFormat(forBus: 0)
let ratio = Int((format.sampleRate / 16000).rounded())
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buf, _ in
    // Channel 0 is the processed voice; the rest are the raw mic array.
    guard let ch = buf.floatChannelData?[0], ratio > 0 else { return }
    let n = Int(buf.frameLength) / ratio
    var out = [Float](repeating: 0, count: n)
    for i in 0..<n {
        var sum: Float = 0
        for j in 0..<ratio { sum += ch[i * ratio + j] }
        out[i] = sum / Float(ratio)
    }
    out.withUnsafeBufferPointer { p in
        FileHandle.standardOutput.write(Data(buffer: p))
    }
}

do {
    try engine.start()
} catch {
    FileHandle.standardError.write("ear: could not start the microphone: \(error)\n".data(using: .utf8)!)
    exit(1)
}
FileHandle.standardError.write("ear: listening at \(format.sampleRate) Hz, \(format.channelCount) channels\n".data(using: .utf8)!)

// Run until whoever started us goes away.
DispatchQueue.global().async {
    while FileHandle.standardInput.availableData.count > 0 {}
    exit(0)
}
RunLoop.main.run()
