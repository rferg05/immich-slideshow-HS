# Immich Slideshow

Home Screens module: a slideshow of one shared **Immich** album. Family members add photos and videos from their iPhones, and they show up on the wall within a couple of minutes. Nothing is copied to the Pi's SD card: the photos live on the NAS, and the module streams them from Immich.

Every photo is **sized to the module it's in**, whatever its size and shape. The module measures its own box (and measures again whenever it's resized in the editor), and fits each photo to it:

- **Fill unless it would crop a lot** (default): a photo fills the box if that cuts off 20% or less, and otherwise shows whole. A landscape photo fills a landscape module, and a portrait photo shows whole in it, on a blurred copy of itself instead of black bars. The same portrait photo fills a tall module.
- **Always show the whole photo** or **Always fill (crops edges)** if you prefer one look.
- The image is fetched at the resolution the box needs: a 2160px preview for anything bigger than a thumbnail, and a 250px thumbnail for tiny modules and the blurred backdrop.

## How it fits together

```
 iPhone ──(Immich app, or upload link in Safari)──▶ Immich on the Pi ──▶ photos & videos on the DS220j (NFS)
                                                         │
 Home Screens display ◀──(album share link)──────────────┘
```

- **Immich** runs in Docker on the same Pi as Home Screens, so it's on whenever the dashboard is. Only its database is on the Pi; photos and videos are stored on the NAS, in date folders (`2026/2026-07-04/IMG_1234.HEIC`), so they're easy to browse and back up there too.
- Immich turns iPhone **HEIC** photos into JPEG previews and **HEVC** videos into H.264, which the Pi's browser can show. Originals are kept untouched.
- The module reads the album through its **share link**. The link's key opens that one album and nothing else in the library.

## Is the Pi big enough?

The installer checks and stops if it isn't.

| Pi | Immich alongside Home Screens |
|---|---|
| Pi 5, 8 GB | Comfortable. |
| Pi 5, 4 GB | Works with machine learning off (the installer turns it off). Upload in batches of tens, not hundreds. |
| Pi 4, 4–8 GB | Photos are fine; converting each iPhone video takes minutes. |
| 2 GB or less, or a 32-bit OS | Not enough: run Immich on another always-on computer. The module works the same. |

To keep the dashboard smooth, the installer caps Immich at half the CPU cores and processes one thumbnail and one video at a time. **Machine learning** (face recognition, "search for beach") is off and its container never starts: it needs more memory than a display Pi can spare.

An SSD instead of the SD card makes the database faster and longer-lived, but isn't required.

## Setup

### 1. Prepare the Synology DS220j

1. **Control Panel > Shared Folder > Create**: name it `immich`. Turn the recycle bin on if you like; skip encryption.
2. **Control Panel > File Services > NFS**: tick **Enable NFS service**, and set *Maximum NFS protocol* to **NFSv4.1**.
3. **Control Panel > Shared Folder** > `immich` > **Edit > NFS Permissions > Create**:
   - Hostname or IP: the Pi's address (e.g. `192.168.1.50`)
   - Privilege: **Read/Write**
   - Squash: **Map all users to admin**
   - Security: `sys`. Tick *Enable asynchronous* and *Allow users to access mounted subfolders*.
4. Note the **Mount path** shown at the bottom of that page, usually `/volume1/immich`.

Give the Pi a fixed address in your router's DHCP settings (a "reservation"), so the NAS rule, the share links and the phones keep finding it.

If you'd rather not use NFS, the installer can use SMB with a DSM user instead (`--smb`).

### 2. Install Immich on the Pi

On the Pi (over SSH or in its terminal), download the installer and run it:

```bash
curl -fsSLO https://raw.githubusercontent.com/rferg05/immich-slideshow-HS/main/install/install-immich.sh
```

```bash
sudo bash install-immich.sh --nfs 192.168.1.20:/volume1/immich
```

Replace `192.168.1.20` with the NAS's address. Without options it asks where to store media. The other forms:

```bash
sudo bash install-immich.sh --smb //192.168.1.20/immich --smb-user immich
sudo bash install-immich.sh --local
```

`--local` keeps media on the Pi, which is handy for a trial run. It installs Docker from Docker's own repository, mounts the NAS, downloads Immich v3.3.5, and starts it on port **2283**. The first start downloads about 2 GB of images and takes a few minutes. When it's done it prints the next steps and saves them to `/opt/immich/NEXT-STEPS.txt`.

### 3. Set up Immich

1. On a phone or laptop, open `http://<pi-address>:2283` and create the **admin** account.
2. **Administration > Users**: add an account for each family member.
3. Create an album called **Dashboard** and share it with those accounts, so they can add to it.
4. In the album, **Share > Create link**: no password, no expiry, *Allow upload* off. Leave *Allow download* on, which animated GIFs need. Copy it. This one is for the dashboard.
5. Optionally make a **second link with Allow upload on**, for guests and anyone who won't install the app (see below).

### 4. Add the module

In the Home Screens editor, open the Plugin Store, choose **Install from URL**, and paste:

```
https://github.com/rferg05/immich-slideshow-HS/releases/latest/download/immich-slideshow.tar.gz
```

This always points at the newest release. Home Screens doesn't check URL-installed plugins for updates on its own, so to update: Plugin Store > **Installed**, then the download icon on Immich Slideshow, then **Install**.

Add an **Immich Slideshow** module to a screen and paste the dashboard link into **Album share link**. It looks like `http://192.168.1.50:2283/share/AbC123...`.

## Adding photos from an iPhone

- **Upload link in Safari (no app, no sign-in):** open the upload link from step 3.5, tap the upload button, and pick photos and videos from the library. Tap Share > *Add to Home Screen* in Safari and it becomes a one-tap icon. It's the easiest way for guests and grandparents.
- **Immich app:** install *Immich* from the App Store, enter the server URL `http://<pi-address>:2283`, and sign in. Select photos and add them to the **Dashboard** album. Turn on backup in the app if you'd also like it to keep a copy of the whole camera roll on the NAS. It's optional, and the dashboard shows only the album.

New photos are picked up at the next album check (every 2 minutes by default). With **Show new uploads next** on, they play right after the current photo.

The phones need to be on the home Wi-Fi to reach the Pi. To upload from anywhere, put the Pi and the phones on [Tailscale](https://tailscale.com/) and use the Pi's Tailscale address in the app.

## Settings

| Setting | Default | |
|---|---|---|
| Album share link | | The dashboard link from Immich. A `/s/<custom-url>` link works too. Links with a password don't. |
| Check the album every | 2 min | One small request, plus one per month of photos whose count changed. |
| Show new uploads next | on | New arrivals play before the rest of the pass, newest first. |
| Order | Shuffle | Or newest/oldest taken first, or most recently added. Every photo plays once per pass either way. |
| Show each photo for | 15 s | |
| Transition | Crossfade, 1 s | Or slide, or none. |
| Slow zoom | off | Ken Burns zoom toward a corner while a photo shows. |
| Play videos | on | Muted, to the end. Off skips them. |
| Animate GIFs | on | Animated GIF, WebP and PNG play, each for at least one full loop. They load the original file, so the share link needs *Allow download* on; without it they show still. |
| Longest a video or animation plays | 60 s | |
| Video sound | off | Browsers may still mute videos until someone has touched the screen. |
| Fit | Fill unless it would crop a lot | See the top of this page. |
| Most to crop when filling | 20% | An iPhone photo (4:3) in a widescreen (16:9) module loses 25% when filling, so at 20% it's shown whole. Set 25 or more to fill. |
| Behind a photo that doesn't fill | Blurred copy | Or the module's own background (Style panel). |
| Caption | Place and date | Place is the city, plus the country when it isn't the one most of the album was taken in. Uses the Style panel's text size. |

The Style panel's background, corner radius, border, shadow and padding all apply. Padding 0 (the default) runs photos to the module's rounded edge.

## When something's wrong

The module says what's wrong instead of going blank:

| Message | What to do |
|---|---|
| *Add an Immich album* | Paste the share link into the module settings. |
| *That isn't an Immich share link* | Use the link from Share in the album. It contains `/share/` or `/s/`. |
| *Can't reach Immich at http://…* | Is the Pi's address still the same? Is Immich up? `cd /opt/immich && sudo docker compose ps` |
| *Immich doesn't recognize this share link* | The link was deleted or expired. Make a new one. |
| *This share link has a password* | Make one without a password for the dashboard. |
| *No photos in "Dashboard" yet* | Add some. If the album only has videos and videos are off, turn them on. |
| *Photos aren't loading from…* | The album lists, but images fail. Check the Pi's address and the NAS mount: `ls /mnt/immich-media/library` |

If Immich stops answering, the module keeps playing what it already has. Photos it can't load are skipped, and failures are written to the Home Screens log.

**Videos:** new iPhone videos play once Immich has converted them. Until then the module skips them, because the Pi can't play the HEVC originals. Conversion is in **Administration > Job Queues > Transcode videos**.

**Changing Immich settings:** the installer manages settings with `/opt/immich/immich.json`, so they're read-only in Administration > Settings. Edit the file, then run `cd /opt/immich && sudo docker compose up -d`.

**Removing Immich** (photos on the NAS are kept):

```bash
cd /opt/immich && sudo docker compose down
```

Then delete `/opt/immich` and the `/mnt/immich-media` line in `/etc/fstab`.

## Development

```bash
npm install
npm test             # share links, Immich responses, fitting, play order
npm run preview      # module against a fake Immich album at http://localhost:5176
npm run build        # dist/bundle.js
```

The preview has buttons for several module sizes, and the module box can also be dragged by its corner to check photos refit live. *Simulate phone upload* adds a photo to the fake album. The URL takes `?w=&h=`, `fs=` for text size, and any config key (`?fit=cover&order=oldest`). For the fake album's video, generate a clip first:

```bash
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=6 -c:v libx264 -pix_fmt yuv420p -movflags +faststart dev/sample.mp4
```

Release tarball:

```bash
mkdir -p release/pkg/immich-slideshow/dist
cp manifest.json release/pkg/immich-slideshow/
cp dist/bundle.js dist/bundle.js.map release/pkg/immich-slideshow/dist/
tar -czf release/immich-slideshow-<version>.tar.gz -C release/pkg immich-slideshow
```

Attach it to a GitHub release tagged `v<version>`, along with a copy named `immich-slideshow.tar.gz` so the `latest/download` URL above keeps working:

```bash
cp release/immich-slideshow-<version>.tar.gz release/immich-slideshow.tar.gz
gh release create v<version> release/immich-slideshow-<version>.tar.gz release/immich-slideshow.tar.gz --title v<version>
```

**How it talks to Immich:** album listings go through the Home Screens proxy (Immich sends no CORS headers), which is why the manifest asks for `localNetwork` with `allowedDomains: ["*"]`: the Immich address is whatever you paste. It uses `GET /api/shared-links/me`, then `GET /api/timeline/buckets` and `/api/timeline/bucket` for the album (Immich v3 no longer lists assets on the album itself). Photos and videos load directly into `<img>`/`<video>` from `/api/assets/{id}/thumbnail` and `/video/playback`, with the share key on the URL.
