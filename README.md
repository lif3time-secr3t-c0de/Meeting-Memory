# 🎙️ **Meeting Memory**
### *Because your brain already has enough to remember*

---

## 🤔 **Ever been in a meeting where...**

- Someone said "I'll send that email" and **never did**?
- You nodded along but **forgot everything** 5 minutes later?
- Everyone made promises but **nobody followed up**?
- You wished you had a **tiny robot assistant** taking notes?

**Meet Meeting Memory** — your unpaid intern that actually works.

---

## ✨ **What This Monster Does**

| Feature | What It Really Means |
|---------|---------------------|
| 🎤 **Browser Recording** | Press red button, talk, look professional |
| ⏱️ **60-Minute Limit** | If your meeting is longer, you need therapy, not software |
| 📤 **Chunked Upload** | Even your terrible office WiFi can handle it |
| 🧠 **AI Transcription** | Whisper writes down everything (including that embarrassing "um") |
| 🔍 **Promise Extraction** | Finds who said they'd do what by when — **so they can't escape** |
| 📋 **Dashboard** | See all promises in one place. Start panicking. |
| 📧 **Email Reminders** | Passive-aggressive but professional |
| 🔗 **Action Links** | Click "Done" or admit you forgot |
| 🚫 **Unsubscribe** | For people who hate being held accountable |
| 🔒 **Privacy** | Audio self-destructs after processing. Very Mission Impossible. |

---

## 🚀 **How It Works (Simplified)**

```
You in meeting: "I'll send the report by Friday"
          ↓
Meeting Memory: *writes it down*
          ↓
Friday morning: *sends you a reminder*
          ↓
You: *panics, sends report*
          ↓
Meeting Memory: *judges you silently*
```

---

## 🏃‍♂️ **Quick Start (Local)**

```bash
# Grab the code (be gentle)
git clone https://github.com/lif3time-secr3t-c0de/Meeting-Memory.git
cd Meeting-Memory/web

# Install the good stuff
npm install

# Python things (AI needs a home)
python -m venv .venv
# Windows: .\.venv\Scripts\activate
# Mac/Linux: source .venv/bin/activate
pip install -r python/requirements.txt

# FFmpeg (magic audio converter)
# Windows: winget install Gyan.FFmpeg
# Mac: brew install ffmpeg
# Linux: sudo apt install ffmpeg

# Copy environment file (don't skip this!)
cp .env.example .env.local

# Run!
npm run dev
```

Visit `http://localhost:3000` and start recording your life away.

---

## 📂 **What's Inside**

```
Meeting-Memory/
├── web/                    # The brain of the operation
│   ├── app/                # Pages and API (the boring stuff)
│   ├── lib/                # Helper functions (the real MVPs)
│   ├── python/             # Whisper speaks Python
│   └── public/             # Pictures and icons
├── db/                     
│   └── schema.sql          # Database blueprints
├── docs/                   
│   └── v1-step*.md         # How we built this monster (13 steps)
└── README.md               # You are here. Hello.
```

---

## 🛠️ **Built With**

- **Next.js 14** — React but make it fancy
- **TypeScript** — JavaScript with anxiety
- **Tailwind CSS** — Write CSS without crying
- **PostgreSQL** — Tables inside tables
- **OpenAI Whisper** — Listens better than your spouse
- **Nodemailer** — Sends emails. So many emails.
- **FFmpeg** — Audio wizardry

---

## 📧 **Email Setup (Don't Skip)**

### Gmail (Free, 500/day)
1. Turn on 2FA (you should already have this)
2. Go to [App Passwords](https://myaccount.google.com/apppasswords)
3. Create "Meeting Memory"
4. Copy the 16-character chaos code
5. Paste in `.env.local`

### SendGrid (Also Free, 100/day)
1. Sign up at sendgrid.com (it's free, I promise)
2. Create API key
3. Copy-paste like your life depends on it

---

## 🔐 **Environment Variables (The Secret Sauce)**

Create `.env.local` in `web/`:

```env
# Database stuff
DATABASE_URL=postgresql://username:password@localhost:5432/meeting_memory
DATABASE_SSL=true

# Where are you?
APP_BASE_URL=http://localhost:3000

# Security (make this random. VERY random)
REMINDER_SIGNING_SECRET=your-super-secret-dont-share-this

# Email (Gmail example)
EMAIL_PROVIDER=gmail_smtp
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
REMINDER_FROM_EMAIL=your-email@gmail.com

# Privacy
DELETE_AUDIO_AFTER_PROCESSING=true

# Optional: OpenAI API key (if you don't want local Whisper)
OPENAI_API_KEY=sk-...
```

---

## 🚢 **Deploy (Make It Public)**

### Vercel + Supabase (The Easy Way)

1. Push code to GitHub (you did this, right?)
2. Create [Supabase](https://supabase.com) project
3. Run `db/schema.sql` in their SQL editor
4. Deploy on [Vercel](https://vercel.com)
5. Add all environment variables
6. Pray. Then click Deploy.

---

## 📚 **Documentation**

We wrote 13 detailed guides. Yes, 13. Like a Netflix series but for code.

Check `/docs` for:
- Step 1: Planning (boring but necessary)
- Step 3: Recording (fun!)
- Step 7: Finding promises (like Where's Waldo but for tasks)
- Step 10: Email reminders (the nagging feature)
- Step 13: Testing (we actually tried it)

---

## 🤝 **License (Read This Part)**

This project has a **split personality** — two licenses:

### 🔓 **Free for Normal Humans**
- ✅ Learning to code
- ✅ Personal projects
- ✅ University assignments
- ✅ "I'm just trying this out"
- ❌ Making money (sorry)

### 💼 **Commercial License (For Money-Makers)**

Need this for your:
- 🏢 Company
- 🚀 Startup
- 💰 SaaS business
- 👔 Client work

**You must buy a commercial license.** One payment. Forever use. Modify all you want.

**Email:** thisiswaliraza@gmail.com  
**Subject:** "I want to make money with your code"

Tell us:
- Who you are
- What you're building
- How many developers

We'll reply with pricing. No robots. No spam. Just business.

---

## 🆘 **Help! Something Broke!**

- **Bugs?** [Open an issue](https://github.com/lif3time-secr3t-c0de/Meeting-Memory/issues)
- **Questions?** Google it first. Then open an issue.
- **Want to pay us?** See license section above 👆
- **Just want to say hi?** ...why?

---

## 👨‍💻 **Made By**

**Wali Raza** (aka lif3time-secr3t-c0de)

*I make computers do things so I don't have to.*

---

## ⭐ **One Last Thing**

If this saved you from one awkward "I forgot" moment, **star the repo**.

If it didn't, star it anyway. Peer pressure.

---

**© 2026 Wali Raza**  
*All rights reserved. Especially the right to make bad jokes in README files.*

---
