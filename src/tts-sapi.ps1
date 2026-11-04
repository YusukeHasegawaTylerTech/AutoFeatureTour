# Windows SAPI text-to-speech: writes a 48 kHz 16-bit mono wav, or lists the installed voices with -List.
param([string]$TextFile, [string]$Wav, [string]$Voice, [int]$Rate = 0, [switch]$List)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($List) { $tts.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }; return }
    if ($Voice) { $tts.SelectVoice($Voice) }
    $tts.Rate = $Rate
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $tts.SetOutputToWaveFile($Wav, $format)
    $tts.Speak([IO.File]::ReadAllText($TextFile))
}
finally { $tts.Dispose() }
