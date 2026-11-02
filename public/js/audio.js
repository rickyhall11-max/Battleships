/**
 * Battleships Audio Engine - Zero-dependency procedural sound generator
 * Uses Web Audio API to create authentic tactical radar, sonar, and naval combat sound FX.
 */
class SoundEngine {
    constructor() {
        this.ctx = null;
        this.muted = localStorage.getItem('battleships_muted') === 'true';
    }

    init() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                this.ctx = new AudioCtx();
            }
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    toggleMute() {
        this.muted = !this.muted;
        localStorage.setItem('battleships_muted', this.muted);
        return this.muted;
    }

    isMuted() {
        return this.muted;
    }

    // Sonar Ping (tactical UI click or radar sweep)
    sonarPing() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(700, this.ctx.currentTime + 0.4);

        gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.5);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.5);
    }

    // Launch Missile (whistle/whoosh)
    launchMissile() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(300, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1100, this.ctx.currentTime + 0.25);

        gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.28);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.28);
    }

    // Direct Hit (deep explosive blast)
    hitExplosion() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        // Noise buffer for blast crunch
        const bufferSize = this.ctx.sampleRate * 0.4;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        // Low-pass filter for explosion rumble
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(500, this.ctx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.4);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.35, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.45);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);

        noise.start();
        noise.stop(this.ctx.currentTime + 0.45);
    }

    // Miss (water splash sound)
    waterSplash() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(450, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(160, this.ctx.currentTime + 0.35);

        gain.gain.setValueAtTime(0.18, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.4);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.4);
    }

    // Ship Sunk (emergency double klaxon alarm)
    shipSunk() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        [0, 0.2, 0.4].forEach(delay => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(650, this.ctx.currentTime + delay);
            osc.frequency.setValueAtTime(520, this.ctx.currentTime + delay + 0.08);

            gain.gain.setValueAtTime(0.2, this.ctx.currentTime + delay);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + delay + 0.16);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(this.ctx.currentTime + delay);
            osc.stop(this.ctx.currentTime + delay + 0.18);
        });
    }

    // Victory Fanfare
    victoryFanfare() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        const notes = [
            { f: 523.25, d: 0.15, wait: 0 },    // C5
            { f: 659.25, d: 0.15, wait: 0.15 }, // E5
            { f: 783.99, d: 0.15, wait: 0.30 }, // G5
            { f: 1046.50, d: 0.5, wait: 0.45 }  // C6
        ];

        notes.forEach(n => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(n.f, this.ctx.currentTime + n.wait);

            gain.gain.setValueAtTime(0.25, this.ctx.currentTime + n.wait);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + n.wait + n.d);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(this.ctx.currentTime + n.wait);
            osc.stop(this.ctx.currentTime + n.wait + n.d + 0.05);
        });
    }

    // Defeat Drone
    defeatSound() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, this.ctx.currentTime + 0.8);

        gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.9);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.9);
    }
}

window.soundEngine = new SoundEngine();

