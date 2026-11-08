# Ecko

A classroom companion for teachers with ALS. Ecko understands slurred speech, writes the whiteboard as the teacher talks, draws diagrams when asked, and can speak in the teacher's own voice whenever they choose.

## Run it

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env   # add your Gemini, ElevenLabs and Tiger Data keys
npm start
```

Then open:
- `http://localhost:3000/board` on the classroom screen
- `http://localhost:3000/phone` on the teacher's phone (the microphone needs HTTPS when it isn't localhost)
- `http://localhost:3000/insights` for the speech tracker and clinic summary

## Built with

Node.js, plain HTML/CSS/JavaScript, Google Gemini, ElevenLabs, Tiger Data (TimescaleDB), Vultr.
