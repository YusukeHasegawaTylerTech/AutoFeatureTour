#:package PdfPig@0.1.16
#:package PDFtoImage@5.4.0
#:property JsonSerializerIsReflectionEnabledByDefault=true
// Turns a synthetic text PDF into an image-only "scan": each page is rendered, tilted slightly, tinted and speckled,
// then placed in a new PDF with no text layer. Used by the pdf-ocr and full tours; only for synthetic corpus files.
//
// With --form, a second scanned page is added: a "persons involved" table with two ID photos and a property table,
// all fictional values (listed in <truth.json> as redact/keep, like manifest.json). The photos are cropped from
// <photo> (two portraits side by side; the crop rectangles are fractions of the image). The first photo is printed
// clearly; the second is a small, faded photocopy, the kind of picture a face detector can miss.
//
// Usage: dotnet run platforms/agenticfoia/make-scan.cs -- <in.pdf> <out.pdf> [--form <photo> <truth.json>]
#pragma warning disable CA1416
using System.Text.Json;
using PDFtoImage;
using SkiaSharp;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Core;
using UglyToad.PdfPig.Writer;

const int Dpi = 150;
var input = File.ReadAllBytes(args[0]);
using var src = PdfDocument.Open(input);
var builder = new PdfDocumentBuilder();
var rng = new Random(20261104);

foreach (var page in src.GetPages())
{
    using var rendered = Conversion.ToImage(input, page: page.Number - 1, options: new RenderOptions(Dpi: Dpi));
    AddScanned(rendered, page.Width, page.Height);
}

if (args.Length >= 5 && args[2] == "--form")
{
    using var form = Form(args[3], out var truth);
    AddScanned(form, 612, 792);
    File.WriteAllText(args[4], JsonSerializer.Serialize(truth, new JsonSerializerOptions { WriteIndented = true }));
}

Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[1]))!);
File.WriteAllBytes(args[1], builder.Build());
using var check = PdfDocument.Open(args[1]);
Console.WriteLine($"{args[1]}: {check.NumberOfPages} page(s), {check.GetPages().Sum(p => p.Letters.Count)} text-layer letters");

void AddScanned(SKBitmap page, double widthPt, double heightPt)
{
    using var scan = new SKBitmap(page.Width, page.Height);
    using (var canvas = new SKCanvas(scan))
    {
        canvas.Clear(new SKColor(246, 244, 238)); // paper tone
        canvas.RotateDegrees(0.6f, scan.Width / 2f, scan.Height / 2f); // fed in slightly crooked
        using var multiply = new SKPaint { BlendMode = SKBlendMode.Multiply };
        using var img = SKImage.FromBitmap(page);
        canvas.DrawImage(img, 0, 0, new SKSamplingOptions(SKFilterMode.Linear), multiply);
        canvas.ResetMatrix();
        using var dot = new SKPaint { Color = new SKColor(0, 0, 0, 60) };
        for (var i = 0; i < 1500; i++) canvas.DrawPoint(rng.Next(scan.Width), rng.Next(scan.Height), dot); // dust
    }
    using var image = SKImage.FromBitmap(scan);
    using var jpg = image.Encode(SKEncodedImageFormat.Jpeg, 80); // scanners usually save JPEG
    builder.AddPage(widthPt, heightPt).AddJpeg(jpg.ToArray(), new PdfRectangle(0, 0, widthPt, heightPt));
}

// A letter-size form at 150 DPI: a header, a persons table with photos, a property table and a signature line.
SKBitmap Form(string photoPath, out object truth)
{
    var bmp = new SKBitmap(1275, 1650);
    var photoBoxes = new List<object>();
    using var c = new SKCanvas(bmp);
    c.Clear(SKColors.White);
    using var type = SKTypeface.FromFamilyName("Courier New");
    using var bold = SKTypeface.FromFamilyName("Courier New", SKFontStyle.Bold);
    using var f = new SKFont(type, 22);
    using var fb = new SKFont(bold, 22);
    using var fh = new SKFont(bold, 26);
    using var ink = new SKPaint { Color = SKColors.Black, IsAntialias = true };
    using var line = new SKPaint { Color = SKColors.Black, StrokeWidth = 2, Style = SKPaintStyle.Stroke };
    void T(string s, float x, float y, SKFont font) => c.DrawText(s, x, y, font, ink);

    T("MILLBROOK POLICE DEPARTMENT", 110, 130, fh);
    T("PERSONS INVOLVED AND PROPERTY / EVIDENCE", 110, 165, fh);
    T("Case Number: 26-45477        Report Date: 07/23/2026", 110, 215, f);
    T("Reporting Officer: Lt. O. Abernathy (#4558)", 110, 248, f);

    // Persons involved: Role | Name | DOB | Phone | Photo
    T("PERSONS INVOLVED", 110, 320, fb);
    float[] px = [110, 260, 560, 760, 970, 1165];
    float top = 340, head = 44, row = 230;
    Grid(px, top, [head, row, row]);
    string[] ph = ["Role", "Name", "DOB", "Phone", "Photo"];
    for (var i = 0; i < ph.Length; i++) T(ph[i], px[i] + 12, top + 30, fb);
    (string Role, string First, string Last, string Dob, string Phone)[] people =
        [("Witness", "Daniel", "Faulkner", "02/13/1964", "(788) 555-0174"), ("Subject", "Tessa", "Brennan", "09/30/1991", "(788) 555-0139")];
    using var photo = SKBitmap.Decode(photoPath) ?? throw new ArgumentException($"Can't read {photoPath}");
    for (var r = 0; r < people.Length; r++)
    {
        var y = top + head + r * row;
        var p = people[r];
        T(p.Role, px[0] + 12, y + 45, f);
        T(p.First, px[1] + 12, y + 45, f);
        T(p.Last, px[1] + 12, y + 78, f);
        T(p.Dob, px[2] + 12, y + 45, f);
        T(p.Phone, px[3] + 12, y + 45, f);
        // Photo 1: clear print. Photo 2: a small, faded, blurry photocopy.
        var crop = r == 0 ? new SKRect(0.17f, 0.22f, 0.455f, 0.69f) : new SKRect(0.575f, 0.22f, 0.86f, 0.69f);
        var cell = new SKRect(px[4] + 20, y + 15, px[5] - 20, y + row - 15);
        var dest = r == 0 ? Fit(cell, crop, photo) : Shrink(Fit(cell, crop, photo), 0.42f);
        DrawPhoto(c, photo, crop, dest, faded: r == 1);
        photoBoxes.Add(new { label = r == 0 ? "Witness photo (clear print)" : "Subject photo (small, faded copy)", box = ExportBox(dest, bmp.Width, bmp.Height) });
    }

    // Property / evidence: Item | Description | Serial / ID | Owner
    var ptop = top + head + 2 * row + 70;
    T("PROPERTY / EVIDENCE", 110, ptop - 20, fb);
    float[] qx = [110, 210, 560, 890, 1165];
    Grid(qx, ptop, [head, 60, 60, 60]);
    string[] qh = ["Item", "Description", "Serial / ID", "Owner"];
    for (var i = 0; i < qh.Length; i++) T(qh[i], qx[i] + 12, ptop + 30, fb);
    string[][] items =
    [
        ["1", "Smartphone, black", "IMEI 356938035643809", "D. Faulkner"],
        ["2", "Wallet, brown leather", "DL 04-823-3911", "T. Brennan"],
        ["3", "Receipt, Commerce St", "No. 004417", "Store"],
    ];
    for (var r = 0; r < items.Length; r++)
        for (var i = 0; i < 4; i++) T(items[r][i], qx[i] + 12, ptop + head + r * 60 + 40, f);

    var sy = ptop + head + 3 * 60 + 110;
    T("Property received by: Lt. O. Abernathy (#4558)      Date: 07/23/2026", 110, sy, f);
    T("Page 2 of 2", 110, 1560, f);

    truth = new
    {
        file = "014-witness-statement-scanned.pdf, page 2",
        redact = new object[]
        {
            new { text = "Faulkner", category = "WitnessName" }, new { text = "Daniel", category = "WitnessName" },
            new { text = "02/13/1964", category = "DateOfBirth" }, new { text = "(788) 555-0174", category = "Phone" },
            new { text = "Tessa", category = "Name" }, new { text = "Brennan", category = "Name" },
            new { text = "09/30/1991", category = "DateOfBirth" }, new { text = "(788) 555-0139", category = "Phone" },
            new { text = "356938035643809", category = "DeviceId" }, new { text = "04-823-3911", category = "DriversLicense" },
            new { text = "D. Faulkner", category = "WitnessName" }, new { text = "T. Brennan", category = "Name" },
        },
        keep = new object[] { new { text = "Lt. O. Abernathy", category = "OfficerName" }, new { text = "4558", category = "BadgeNumber" } },
        // Where each photo is on page 2, in the pixels AgenticFOIA uses (200 DPI, after the scan tilt).
        photos = photoBoxes,
    };
    return bmp;

    void Grid(float[] xs, float y0, float[] heights)
    {
        var y = y0;
        var ys = new List<float> { y };
        foreach (var h in heights) ys.Add(y += h);
        foreach (var yy in ys) c.DrawLine(xs[0], yy, xs[^1], yy, line);
        foreach (var xx in xs) c.DrawLine(xx, ys[0], xx, ys[^1], line);
    }
}

static SKRect Fit(SKRect cell, SKRect crop, SKBitmap photo)
{
    var aspect = crop.Width * photo.Width / (crop.Height * photo.Height);
    var h = cell.Height; var w = h * aspect;
    if (w > cell.Width) { w = cell.Width; h = w / aspect; }
    return SKRect.Create(cell.MidX - w / 2, cell.MidY - h / 2, w, h);
}

static SKRect Shrink(SKRect r, float k) => SKRect.Create(r.MidX - r.Width * k / 2, r.MidY - r.Height * k / 2, r.Width * k, r.Height * k);

static void DrawPhoto(SKCanvas c2, SKBitmap photo, SKRect crop, SKRect dest, bool faded)
{
    var s = new SKRect(crop.Left * photo.Width, crop.Top * photo.Height, crop.Right * photo.Width, crop.Bottom * photo.Height);
    using var img = SKImage.FromBitmap(photo);
    using var paint = new SKPaint();
    if (faded)
    {
        // Grey, washed out and soft, like a third-generation photocopy of an ID card.
        float[] m =
        [
            0.12f, 0.24f, 0.04f, 0, 0.55f,
            0.12f, 0.24f, 0.04f, 0, 0.55f,
            0.12f, 0.24f, 0.04f, 0, 0.55f,
            0, 0, 0, 1, 0,
        ];
        paint.ColorFilter = SKColorFilter.CreateColorMatrix(m);
        paint.ImageFilter = SKImageFilter.CreateBlur(1.6f, 1.6f);
    }
    c2.DrawImage(img, s, dest, new SKSamplingOptions(SKFilterMode.Linear), paint);
    using var border = new SKPaint { Color = SKColors.Black, StrokeWidth = 1.5f, Style = SKPaintStyle.Stroke };
    c2.DrawRect(dest, border);
}

// A rectangle drawn on the 150 DPI form, where it lands on the scanned page rendered at 200 DPI (AgenticFOIA's
// Export:PdfDpi): rotated with the page by the scan tilt, then scaled. Returns the bounding box, rounded outwards.
static object ExportBox(SKRect r, int width, int height)
{
    var m = SKMatrix.CreateRotationDegrees(0.6f, width / 2f, height / 2f);
    var pts = m.MapPoints([new(r.Left, r.Top), new(r.Right, r.Top), new(r.Left, r.Bottom), new(r.Right, r.Bottom)]);
    const float k = 200f / Dpi;
    float x0 = pts.Min(p => p.X) * k, y0 = pts.Min(p => p.Y) * k, x1 = pts.Max(p => p.X) * k, y1 = pts.Max(p => p.Y) * k;
    return new { t = 2, x = (int)MathF.Floor(x0), y = (int)MathF.Floor(y0), w = (int)MathF.Ceiling(x1 - x0), h = (int)MathF.Ceiling(y1 - y0) };
}
