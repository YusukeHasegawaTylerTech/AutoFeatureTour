# Windows SAPI text-to-speech: writes a wav in the voice's own format (tts.mjs converts it to 48 kHz mono), or lists the
# installed voices with -List. -Words <file>: also writes when each word starts, as JSON { end, marks: [{ t, c, n }] }
# (seconds, character position and length; AftWordMarks below says how to read them).
param([string]$TextFile, [string]$Wav, [string]$Voice, [int]$Rate = 0, [string]$Words, [switch]$List)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($List) { $tts.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }; return }
    if ($Voice) { $tts.SelectVoice($Voice) }
    $tts.Rate = $Rate
    $tts.SetOutputToWaveFile($Wav)
    if (-not $Words) { $tts.Speak([IO.File]::ReadAllText($TextFile)); return }
    # The word events are collected in C#: a PowerShell handler or event queue fails (exit 2, no message) on SAPI's
    # thread once a narration is longer than a few words.
    Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System.Collections.Generic;
using System.Globalization;
using System.Speech.Synthesis;
public static class AftWordMarks {
    // AudioPosition runs fast by a factor that depends on the voice, so a bookmark marks the end of the text: tts.mjs
    // scales every time by the wav's real length over "end". The text goes in through a PromptBuilder (for the
    // bookmark), which offsets CharacterPosition by its SSML header; tts.mjs takes that offset from the first word.
    public static string Speak(SpeechSynthesizer tts, string text) {
        var marks = new List<string>();
        double end = -1;
        tts.SpeakProgress += (s, e) => { lock (marks) marks.Add(string.Format(CultureInfo.InvariantCulture, "{{\"t\":{0:0.###},\"c\":{1},\"n\":{2}}}",
            e.AudioPosition.TotalSeconds, e.CharacterPosition, e.CharacterCount)); };
        tts.BookmarkReached += (s, e) => { end = e.AudioPosition.TotalSeconds; };
        var prompt = new PromptBuilder();
        prompt.AppendText(text);
        prompt.AppendBookmark("end");
        tts.Speak(prompt);
        lock (marks) return string.Format(CultureInfo.InvariantCulture, "{{\"end\":{0:0.###},\"marks\":[{1}]}}", end, string.Join(",", marks));
    }
}
'@
    [IO.File]::WriteAllText($Words, [AftWordMarks]::Speak($tts, [IO.File]::ReadAllText($TextFile)))
}
finally { $tts.Dispose() }
