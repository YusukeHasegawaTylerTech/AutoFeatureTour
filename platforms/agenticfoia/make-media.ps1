<#
.SYNOPSIS
  Generates the fictional media files the tour uploads: a body-camera clip, a 911 call and an evidence photo.

.DESCRIPTION
  Everything is synthetic: speech comes from Windows text-to-speech, pictures from ffmpeg drawing, and every name,
  phone number and plate is invented (phone numbers use the never-issued 555-01xx range). Nothing is downloaded.
  Writes bodycam-unit12.mp4, 911-call.mp3 and evidence-note.png to -OutDir, plus media.json describing where the
  licence plate is drawn (so the recorder knows where to draw its box).
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$inv = [Globalization.CultureInfo]::InvariantCulture

function Invoke-Native([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "$exe failed (exit $LASTEXITCODE): $($arguments -join ' ')" }
}
function Get-Duration([string]$path) {
    $d = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $path
    [double]::Parse(($d | Select-Object -First 1), $inv)
}

# Speaks lines alternately in the installed voices (falls back to one voice) into one wav, with pauses between.
function New-Speech([string]$wav, [string[]]$lines) {
    $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $voices = @($tts.GetInstalledVoices() | Where-Object Enabled | ForEach-Object { $_.VoiceInfo.Name })
        $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
        $tts.SetOutputToWaveFile($wav, $format)
        $tts.Rate = -1
        $p = New-Object System.Speech.Synthesis.PromptBuilder
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $p.StartVoice($voices[$i % $voices.Count]); $p.AppendText($lines[$i]); $p.EndVoice()
            $p.AppendBreak([TimeSpan]::FromMilliseconds(700))
        }
        $tts.Speak($p)
    }
    finally { $tts.Dispose() }
}

$font = "fontfile='C\:/Windows/Fonts/segoeui.ttf'"
$bold = "fontfile='C\:/Windows/Fonts/segoeuib.ttf'"
$mono = "fontfile='C\:/Windows/Fonts/consolab.ttf'"

Push-Location $OutDir
try {
    # ---- Body-camera clip: a parked car with a licence plate, a timestamp overlay, and the officer's radio call.
    New-Speech "$OutDir\bodycam.wav" @(
        "Dispatch, unit twelve. I'm out with the complainant, Marisol Fenwick, in the Delmar Market parking lot.",
        "Unit twelve, copy. Go ahead.",
        "She says the driver of a gray sedan backed into her car and left. Her callback number is five five five, zero one four seven.",
        "Copy. Do you have a plate?",
        "Partial plate, seven X-ray K D four one nine. Ms. Fenwick says the other driver was a man named Curtis Albright."
    )
    $len = [math]::Ceiling((Get-Duration "$OutDir\bodycam.wav") + 1.5)
    # Car rear (body, window, lights) with a white plate; plate box is at x=560..720, y=470..550 in the 1280x720 frame.
    $plate = @{ x = 560; y = 470; w = 160; h = 80 }
    $vf = @(
        "drawbox=x=0:y=560:w=1280:h=160:color=0x3a3d42:t=fill",                     # asphalt
        "drawbox=x=380:y=300:w=520:h=300:color=0x6f7680:t=fill",                    # car body
        "drawbox=x=440:y=320:w=400:h=110:color=0x1d2733:t=fill",                    # rear window
        "drawbox=x=395:y=450:w=90:h=40:color=0xb3261e:t=fill",                      # tail lights
        "drawbox=x=795:y=450:w=90:h=40:color=0xb3261e:t=fill",
        "drawbox=x=$($plate.x):y=$($plate.y):w=$($plate.w):h=$($plate.h):color=white:t=fill",
        "drawtext=$($mono):text='7XKD419':fontcolor=0x10224a:fontsize=40:x=$($plate.x)+(160-tw)/2:y=$($plate.y)+22",
        "drawbox=x=0:y=0:w=1280:h=56:color=black@0.55:t=fill",
        "drawtext=$($mono):text='BODY CAM  UNIT 12  10/14/2026 22\:41\:%{eif\:t\:d\:2}':fontcolor=white:fontsize=26:x=24:y=14",
        "drawtext=$($bold):text='REC':fontcolor=0xff4040:fontsize=26:x=1180:y=14"
    ) -join ','
    Invoke-Native ffmpeg @('-y', '-v', 'error',
        '-f', 'lavfi', '-i', "color=c=0x50606e:s=1280x720:r=30:d=$len",
        '-i', "$OutDir\bodycam.wav",
        '-vf', $vf, '-af', 'apad', '-t', "$len",
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', 'bodycam-unit12.mp4')

    # ---- 911 call (audio only).
    New-Speech "$OutDir\call.wav" @(
        "Nine one one, what is the address of your emergency?",
        "Four eighteen Larch Street. My neighbor, Tomas Reyes, fell down the back steps and he isn't answering me.",
        "Okay. Is he breathing? What's your name and a number where I can reach you?",
        "Yes, he's breathing. I'm Grace Holloway, my cell is five five five, zero one eight two."
    )
    Invoke-Native ffmpeg @('-y', '-v', 'error', '-i', "$OutDir\call.wav", '-ac', '1', '-b:a', '96k', '911-call.mp3')

    # ---- Evidence photo: a note on a desk.
    $note = @(
        "drawbox=x=260:y=150:w=760:h=500:color=0xfdf6d8:t=fill",
        "drawtext=$($bold):text='Evidence item 14 - note found in vehicle':fontcolor=0x222222:fontsize=34:x=300:y=200",
        "drawtext=$($font):text='Call Dana Whitcomb':fontcolor=0x1a237e:fontsize=48:x=300:y=300",
        "drawtext=$($font):text='Phone 555-0193':fontcolor=0x1a237e:fontsize=48:x=300:y=380",
        "drawtext=$($font):text='Meet behind 220 Orchard Rd':fontcolor=0x1a237e:fontsize=48:x=300:y=460"
    ) -join ','
    Invoke-Native ffmpeg @('-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x8d6e53:s=1280x800', '-vf', $note, '-frames:v', '1', 'evidence-note.png')

    $info = @{ video = 'bodycam-unit12.mp4'; width = 1280; height = 720; plate = $plate }
    [IO.File]::WriteAllText("$OutDir\media.json", ($info | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Remove-Item "$OutDir\bodycam.wav", "$OutDir\call.wav"
}
finally { Pop-Location }
Write-Host "Media written to $OutDir"
