# VoiceLatch icon generator — draws the app icon from scratch with System.Drawing.
# Outputs:
#   assets/icons/icon-{16,24,32,48,64,128,256}.png   app icon rasters
#   assets/icons/tray-{16,32}.png / tray-rec-{16,32}.png
#   assets/icons/tray.ico, tray-rec.ico              tray icons (idle / recording)
#   build/icon.ico                                   multi-size app icon (PNG-compressed entries)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root "assets\icons"
$buildDir = Join-Path $root "build"
New-Item -ItemType Directory -Force $iconDir | Out-Null
New-Item -ItemType Directory -Force $buildDir | Out-Null

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# Draws the mic glyph centered in a 256-unit design space, scaled to $size.
function Draw-Icon([int]$size, [bool]$withBackground, [System.Drawing.Color]$micColor, [bool]$recordingDot) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $s = $size / 256.0

    if ($withBackground) {
        $bgPath = New-RoundedRectPath (8 * $s) (8 * $s) (240 * $s) (240 * $s) (56 * $s)
        $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.PointF(0, 0)),
            (New-Object System.Drawing.PointF($size, $size)),
            [System.Drawing.Color]::FromArgb(255, 124, 92, 255),   # violet
            [System.Drawing.Color]::FromArgb(255, 0, 206, 201))    # teal
        $g.FillPath($grad, $bgPath)
        $grad.Dispose(); $bgPath.Dispose()
    }

    $penW = [Math]::Max(1.0, 16 * $s)
    $pen = New-Object System.Drawing.Pen($micColor, $penW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $brush = New-Object System.Drawing.SolidBrush($micColor)

    # capsule (mic body): x 100..156, y 56..148, corner r 28
    $cap = New-RoundedRectPath (100 * $s) (56 * $s) (56 * $s) (92 * $s) (28 * $s)
    $g.FillPath($brush, $cap); $cap.Dispose()
    # cradle arc: half-circle r 52 centered (128,140), opening upward
    $g.DrawArc($pen, [float]((128 - 52) * $s), [float]((140 - 52) * $s), [float](104 * $s), [float](104 * $s), 15, 150)
    # stem + base
    $g.DrawLine($pen, [float](128 * $s), [float](196 * $s), [float](128 * $s), [float](216 * $s))
    $g.DrawLine($pen, [float](96 * $s), [float](216 * $s), [float](160 * $s), [float](216 * $s))

    if ($recordingDot) {
        $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 71, 87))
        $r = 64 * $s
        $g.FillEllipse($dotBrush, [float]($size - $r - 6 * $s), [float](6 * $s), [float]$r, [float]$r)
        $dotBrush.Dispose()
    }

    $pen.Dispose(); $brush.Dispose(); $g.Dispose()
    return $bmp
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# Multi-size ICO with PNG-compressed entries (valid since Vista).
function Write-Ico([string]$path, [string[]]$pngPaths) {
    $entries = @()
    foreach ($p in $pngPaths) {
        $bytes = [System.IO.File]::ReadAllBytes($p)
        $img = [System.Drawing.Image]::FromFile($p)
        $entries += ,@{ W = $img.Width; H = $img.Height; Bytes = $bytes }
        $img.Dispose()
    }
    $fs = [System.IO.File]::Create($path)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$entries.Count)
    $offset = 6 + 16 * $entries.Count
    foreach ($e in $entries) {
        $bw.Write([byte]($(if ($e.W -ge 256) { 0 } else { $e.W })))
        $bw.Write([byte]($(if ($e.H -ge 256) { 0 } else { $e.H })))
        $bw.Write([byte]0); $bw.Write([byte]0)
        $bw.Write([uint16]1); $bw.Write([uint16]32)
        $bw.Write([uint32]$e.Bytes.Length)
        $bw.Write([uint32]$offset)
        $offset += $e.Bytes.Length
    }
    foreach ($e in $entries) { $bw.Write($e.Bytes) }
    $bw.Close(); $fs.Close()
}

$white = [System.Drawing.Color]::White
$appPngs = @()
foreach ($size in 16, 24, 32, 48, 64, 128, 256) {
    $bmp = Draw-Icon $size $true $white $false
    $p = Join-Path $iconDir ("icon-{0}.png" -f $size)
    Save-Png $bmp $p; $bmp.Dispose()
    $appPngs += $p
}
Write-Ico (Join-Path $buildDir "icon.ico") $appPngs

# Tray: gradient tile reads well on both light and dark taskbars.
$trayPngs = @(); $trayRecPngs = @()
foreach ($size in 16, 32) {
    $bmp = Draw-Icon $size $true $white $false
    $p = Join-Path $iconDir ("tray-{0}.png" -f $size)
    Save-Png $bmp $p; $bmp.Dispose(); $trayPngs += $p

    $bmp = Draw-Icon $size $true $white $true
    $p = Join-Path $iconDir ("tray-rec-{0}.png" -f $size)
    Save-Png $bmp $p; $bmp.Dispose(); $trayRecPngs += $p
}
Write-Ico (Join-Path $iconDir "tray.ico") $trayPngs
Write-Ico (Join-Path $iconDir "tray-rec.ico") $trayRecPngs

Write-Output ("ICONS-OK " + (Get-ChildItem $iconDir).Count + " files, ico=" + (Get-Item (Join-Path $buildDir "icon.ico")).Length + "B")
