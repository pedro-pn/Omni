package main

import (
	"encoding/binary"
	"errors"
	"io"
	"math"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

const sampleRate = 16000
const frameSamples = 960 // 60 ms: cadência do codec do meowcaller fixado no go.mod.

// Os dois canais compartilham o relógio. Silêncio preenche atrasos de cada lado.
// Esquerda = microfone efetivamente enviado; direita = áudio recebido do cliente.
type stereoRecorder struct {
	mu      sync.Mutex
	file    *os.File
	started time.Time
	next    [2]int64
	frames  int64
	closed  bool
	err     error
	enabled bool
	// Amostras por canal que cabem na gravação: a duração máxima da ligação
	// (CHAMADA_LIMITE_SEGUNDOS) com uma folga para o encerramento.
	limit int64
}

// recordingSlack cobre o atraso entre o limite da ligação e o fim da gravação.
const recordingSlack = 10 * time.Second

func newRecorder(path string, maxDuration time.Duration) (*stereoRecorder, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	r := &stereoRecorder{file: f, enabled: true, limit: int64((maxDuration + recordingSlack).Seconds() * sampleRate)}
	if _, err = f.Write(make([]byte, 44)); err != nil {
		f.Close()
		return nil, err
	}
	return r, nil
}

func (r *stereoRecorder) enable(enabled bool) {
	r.mu.Lock()
	r.enabled = enabled
	r.mu.Unlock()
}

func (r *stereoRecorder) start() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started.IsZero() {
		r.started = time.Now()
	}
}

func (r *stereoRecorder) write(channel int, frame []float32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.enabled || r.closed || r.started.IsZero() || r.err != nil || channel < 0 || channel > 1 {
		return
	}
	position := max(r.next[channel], int64(time.Since(r.started).Seconds()*sampleRate)-int64(len(frame)))
	// Nunca grava além da duração máxima da ligação, mesmo se um encerramento atrasar.
	if position+int64(len(frame)) > r.limit {
		return
	}
	block := make([]byte, len(frame)*4)
	_, err := r.file.ReadAt(block, 44+position*4)
	if err != nil && !errors.Is(err, io.EOF) {
		r.err = err
		return
	}
	for i, sample := range frame {
		if math.IsNaN(float64(sample)) {
			sample = 0
		}
		sample = max(-1, min(sample, 32767.0/32768.0))
		binary.LittleEndian.PutUint16(block[4*i+2*channel:], uint16(int16(sample*32768)))
	}
	_, r.err = r.file.WriteAt(block, 44+position*4)
	r.next[channel] = position + int64(len(frame))
	r.frames = max(r.frames, r.next[channel])
}

func (r *stereoRecorder) close() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.frames, r.err
	}
	r.closed = true
	var h [44]byte
	copy(h[:4], "RIFF")
	copy(h[8:12], "WAVE")
	copy(h[12:16], "fmt ")
	copy(h[36:40], "data")
	binary.LittleEndian.PutUint32(h[4:8], uint32(36+r.frames*4))
	binary.LittleEndian.PutUint32(h[16:20], 16)
	binary.LittleEndian.PutUint16(h[20:22], 1)
	binary.LittleEndian.PutUint16(h[22:24], 2)
	binary.LittleEndian.PutUint32(h[24:28], sampleRate)
	binary.LittleEndian.PutUint32(h[28:32], sampleRate*4)
	binary.LittleEndian.PutUint16(h[32:34], 4)
	binary.LittleEndian.PutUint16(h[34:36], 16)
	binary.LittleEndian.PutUint32(h[40:44], uint32(r.frames*4))
	_, headerErr := r.file.WriteAt(h[:], 0)
	r.err = errors.Join(r.err, headerErr, r.file.Sync(), r.file.Close())
	return r.frames, r.err
}

// A gravação original mantém os participantes separados. Para escuta comum,
// mistura os dois em ambos os canais, inclusive em arquivos já existentes.
// ReaderAt + SectionReader preservam as requisições HTTP Range sem carregar
// toda a gravação em memória nem criar outra cópia no disco.
func recordingForPlayback(source io.ReaderAt, size int64) (io.ReadSeeker, error) {
	var header [44]byte
	if _, err := source.ReadAt(header[:], 0); err != nil {
		return nil, err
	}
	dataSize := int64(binary.LittleEndian.Uint32(header[40:44]))
	if string(header[:4]) != "RIFF" || string(header[8:16]) != "WAVEfmt " ||
		binary.LittleEndian.Uint32(header[16:20]) != 16 ||
		binary.LittleEndian.Uint16(header[20:22]) != 1 ||
		binary.LittleEndian.Uint16(header[22:24]) != 2 ||
		binary.LittleEndian.Uint16(header[32:34]) != 4 ||
		binary.LittleEndian.Uint16(header[34:36]) != 16 ||
		string(header[36:40]) != "data" || dataSize%4 != 0 || dataSize > size-44 {
		return nil, errors.New("formato de gravação inválido")
	}
	return io.NewSectionReader(mixedRecording{source}, 0, 44+dataSize), nil
}

type mixedRecording struct{ source io.ReaderAt }

func (r mixedRecording) ReadAt(buffer []byte, offset int64) (int, error) {
	if offset < 0 {
		return 0, errors.New("posição de gravação inválida")
	}
	written := 0
	if offset < 44 {
		length := min(len(buffer), int(44-offset))
		n, err := r.source.ReadAt(buffer[:length], offset)
		written += n
		offset += int64(n)
		buffer = buffer[n:]
		if err != nil {
			return written, err
		}
	}
	if len(buffer) == 0 {
		return written, nil
	}
	// Um intervalo HTTP pode começar ou terminar no meio de uma amostra.
	skip := int((offset - 44) % 4)
	raw := make([]byte, (skip+len(buffer)+3)/4*4)
	n, err := r.source.ReadAt(raw, offset-int64(skip))
	complete := n / 4 * 4
	for i := 0; i < complete; i += 4 {
		left := int32(int16(binary.LittleEndian.Uint16(raw[i:])))
		right := int32(int16(binary.LittleEndian.Uint16(raw[i+2:])))
		// A média mantém margem quando os dois participantes falam juntos.
		mixed := uint16(int16((left + right) / 2))
		binary.LittleEndian.PutUint16(raw[i:], mixed)
		binary.LittleEndian.PutUint16(raw[i+2:], mixed)
	}
	if complete > skip {
		written += copy(buffer, raw[skip:complete])
	}
	if complete-skip < len(buffer) {
		if err == nil {
			err = io.EOF
		}
		return written, err
	}
	return written, nil
}

type audioBridge struct {
	mic        chan []float32
	playback   chan []byte
	recorder   *stereoRecorder
	closed     atomic.Bool
	active     atomic.Bool
	micFrames  atomic.Uint64
	peerFrames atomic.Uint64
	dropped    atomic.Uint64
}

func newAudioBridge(r *stereoRecorder) *audioBridge {
	return &audioBridge{mic: make(chan []float32, 5), playback: make(chan []byte, 8), recorder: r}
}

func (b *audioBridge) start() {
	if b.active.CompareAndSwap(false, true) {
		b.recorder.start()
	}
}

func (b *audioBridge) pushPCM(data []byte) error {
	if len(data) != frameSamples*2 {
		return errors.New("quadro de áudio inválido")
	}
	if b.closed.Load() || !b.active.Load() {
		return nil
	}
	frame := make([]float32, frameSamples)
	for i := range frame {
		frame[i] = float32(int16(binary.LittleEndian.Uint16(data[2*i:]))) / 32768
	}
	select {
	case b.mic <- frame:
	default:
		b.dropped.Add(1)
	}
	return nil
}

// ReadFrame nunca bloqueia a cadência do codec esperando a rede do navegador.
func (b *audioBridge) ReadFrame() ([]float32, error) {
	if b.closed.Load() {
		return nil, io.EOF
	}
	frame := make([]float32, frameSamples)
	select {
	case frame = <-b.mic:
		b.micFrames.Add(1)
	default:
	}
	if b.active.Load() {
		b.recorder.write(0, frame)
	}
	return frame, nil
}

func (b *audioBridge) WriteFrame(frame []float32) error {
	if b.closed.Load() || !b.active.Load() {
		return nil
	}
	b.peerFrames.Add(1)
	b.recorder.write(1, frame)
	data := make([]byte, len(frame)*2)
	for i, s := range frame {
		binary.LittleEndian.PutUint16(data[2*i:], uint16(int16(max(-1, min(s, 32767.0/32768.0))*32768)))
	}
	select {
	case b.playback <- data:
	default:
		b.dropped.Add(1)
	}
	return nil
}

// O motor fecha source e sink; a aplicação finaliza o WAV depois do fim da chamada.
func (b *audioBridge) Close() error { b.closed.Store(true); return nil }
