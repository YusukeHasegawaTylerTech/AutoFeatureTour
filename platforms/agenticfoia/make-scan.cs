#:package PdfPig@0.1.16
#:package PDFtoImage@5.4.0
// Turns a synthetic text PDF into an image-only "scan": each page is rendered, tilted slightly, tinted and speckled,
// then placed in a new PDF with no text layer. Used by the pdf-ocr tour; only for synthetic corpus files.
// Usage: dotnet run targets/agenticfoia/make-scan.cs -- <in.pdf> <out.pdf>
#pragma warning disable CA1416
using PDFtoImage;
using SkiaSharp;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Core;
using UglyToad.PdfPig.Writer;

var input = File.ReadAllBytes(args[0]);
using var src = PdfDocument.Open(input);
var builder = new PdfDocumentBuilder();
var rng = new Random(20261104);
foreach (var page in src.GetPages())
{
    using var rendered = Conversion.ToImage(input, page: page.Number - 1, options: new RenderOptions(Dpi: 150));
    using var scan = new SKBitmap(rendered.Width, rendered.Height);
    using (var canvas = new SKCanvas(scan))
    {
        canvas.Clear(new SKColor(246, 244, 238)); // paper tone
        canvas.RotateDegrees(0.6f, scan.Width / 2f, scan.Height / 2f); // fed in slightly crooked
        using var multiply = new SKPaint { BlendMode = SKBlendMode.Multiply };
        canvas.DrawImage(SKImage.FromBitmap(rendered), 0, 0, new SKSamplingOptions(SKFilterMode.Linear), multiply);
        canvas.ResetMatrix();
        using var dot = new SKPaint { Color = new SKColor(0, 0, 0, 60) };
        for (var i = 0; i < 1500; i++) canvas.DrawPoint(rng.Next(scan.Width), rng.Next(scan.Height), dot); // dust
    }
    using var image = SKImage.FromBitmap(scan);
    using var jpg = image.Encode(SKEncodedImageFormat.Jpeg, 80); // scanners usually save JPEG
    builder.AddPage(page.Width, page.Height).AddJpeg(jpg.ToArray(), new PdfRectangle(0, 0, page.Width, page.Height));
}
Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[1]))!);
File.WriteAllBytes(args[1], builder.Build());
using var check = PdfDocument.Open(args[1]);
Console.WriteLine($"{args[1]}: {check.NumberOfPages} page(s), {check.GetPages().Sum(p => p.Letters.Count)} text-layer letters");
