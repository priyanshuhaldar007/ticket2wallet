# Ticket2Wallet

Convert an IRCTC e-ticket (PDF or screenshot) into an Apple Wallet `.pkpass`.
Fully client side: static files only, nothing is uploaded. Free to host on GitHub Pages, Netlify, Cloudflare Pages, etc.

## Why you need a certificate
Apple Wallet only installs passes that are cryptographically signed with a **Pass Type ID certificate**. A static site cannot hold a secret, so you sign with your own certificate, which you load in the page (kept only in your browser). This needs an Apple Developer Program membership (USD 99/year). There is no way around this for a self-made pass.

## One-time setup (about 10 minutes, on a Mac)
1. developer.apple.com > Certificates, Identifiers & Profiles > Identifiers > **+** > *Pass Type IDs*. Register e.g. `pass.com.yourname.irctc`.
2. Keychain Access > Certificate Assistant > *Request a Certificate From a Certificate Authority*, save the CSR to disk.
3. Open your Pass Type ID > *Create Certificate*, upload the CSR, download the `.cer`, double click to install it.
4. In Keychain Access > My Certificates, right click the *Pass Type ID* certificate > Export > `.p12`, set a password.
5. Download **Worldwide Developer Relations - G4** (`AppleWWDRCAG4.cer`) from apple.com/certificateauthority.

## Use
Open the site, load the `.p12` + password + WWDR `.cer` (tick "remember" to skip next time), upload the ticket, check the fields, tap **Create Wallet pass**, then open the downloaded `.pkpass` on your iPhone (Safari) and tap **Add**.
The Pass Type ID and Team ID are read from the certificate automatically.

## Deploy free on GitHub Pages
1. Push this folder to a GitHub repo.
2. Settings > Pages > Source: *Deploy from a branch* > `main` / root.
3. Visit `https://<you>.github.io/<repo>/`.

Local test: `python3 -m http.server` and open http://localhost:8000.

## Notes
- Ticket details are read heuristically from the PDF text. Always check the fields before creating the pass.
- The original QR code is decoded from the PDF and reused as the pass barcode when found.
- Libraries are vendored in `vendor/` (pdf.js, jsQR, JSZip, node-forge), so the site works with no CDN.
- Wallet pass is a convenience copy. Keep the original ticket and valid ID with you.
