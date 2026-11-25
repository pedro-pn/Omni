package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func stereoFixture() ([]byte, []byte) {
	pairs := [][2]int16{{12000, 0}, {0, -12000}, {20000, 20000}, {-32768, -32768}, {32767, 32767}, {30000, -10000}, {1, 0}, {-1, 0}, {8000, -4000}}
	expected := []int16{6000, -6000, 20000, -32768, 32767, 10000, 0, 0, 2000}
	raw := make([]byte, 44+len(pairs)*4)
	copy(raw[:4], "RIFF")
	copy(raw[8:16], "WAVEfmt ")
	copy(raw[36:40], "data")
	binary.LittleEndian.PutUint32(raw[4:8], uint32(len(raw)-8))
	binary.LittleEndian.PutUint32(raw[16:20], 16)
	binary.LittleEndian.PutUint16(raw[20:22], 1)
	binary.LittleEndian.PutUint16(raw[22:24], 2)
	binary.LittleEndian.PutUint32(raw[24:28], sampleRate)
	binary.LittleEndian.PutUint32(raw[28:32], sampleRate*4)
	binary.LittleEndian.PutUint16(raw[32:34], 4)
	binary.LittleEndian.PutUint16(raw[34:36], 16)
	binary.LittleEndian.PutUint32(raw[40:44], uint32(len(raw)-44))
	want := bytes.Clone(raw)
	for i, pair := range pairs {
		binary.LittleEndian.PutUint16(raw[44+4*i:], uint16(pair[0]))
		binary.LittleEndian.PutUint16(raw[46+4*i:], uint16(pair[1]))
		binary.LittleEndian.PutUint16(want[44+4*i:], uint16(expected[i]))
		binary.LittleEndian.PutUint16(want[46+4*i:], uint16(expected[i]))
	}
	return raw, want
}

func TestRecordingPlaybackBalancesBothEarsWithoutClipping(t *testing.T) {
	raw, want := stereoFixture()
	for chunk := 1; chunk <= 17; chunk++ {
		reader, err := recordingForPlayback(bytes.NewReader(raw), int64(len(raw)))
		if err != nil {
			t.Fatal(err)
		}
		var got []byte
		buffer := make([]byte, chunk)
		for {
			n, err := reader.Read(buffer)
			got = append(got, buffer[:n]...)
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("mistura incorreta com blocos de %d bytes", chunk)
		}
		if _, err = reader.Seek(45, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		tail, err := io.ReadAll(reader)
		if err != nil || !bytes.Equal(tail, want[45:]) {
			t.Fatal("busca no meio de amostra não preservou o áudio")
		}
	}
}

func TestPlaybackForExistingRecordingKeepsOriginalAndSupportsRange(t *testing.T) {
	a := testApp(t)
	id := randomID()
	raw, want := stereoFixture()
	path := filepath.Join(a.cfg.dataDir, id+".wav")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.records = append(a.records, callInfo{ID: id, Audio: true})
	a.mu.Unlock()
	server := localServer(t, a)
	for _, test := range []struct {
		query, byteRange string
		status           int
		want             []byte
	}{
		{"", "", 200, want},
		{"?canais=separados", "", 200, raw},
		{"", "bytes=45-58", 206, want[45:59]},
		{"?canais=separados", "bytes=45-58", 206, raw[45:59]},
	} {
		req, _ := http.NewRequest("GET", server.URL+"/api/recordings/"+id+".wav"+test.query, nil)
		req.AddCookie(&http.Cookie{Name: "omni_chamada_poc", Value: a.token})
		if test.byteRange != "" {
			req.Header.Set("Range", test.byteRange)
		}
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != test.status || !bytes.Equal(data, test.want) {
			t.Fatalf("reprodução incorreta: query=%q range=%q status=%d", test.query, test.byteRange, response.StatusCode)
		}
	}
	preserved, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(preserved, raw) {
		t.Fatal("reprodução alterou o arquivo original")
	}
}

func TestRecordingPlaybackRejectsTruncatedOrUnsupportedWAV(t *testing.T) {
	raw, _ := stereoFixture()
	if _, err := recordingForPlayback(bytes.NewReader(raw[:40]), 40); err == nil {
		t.Fatal("cabeçalho incompleto aceito")
	}
	if _, err := recordingForPlayback(bytes.NewReader(raw[:len(raw)-1]), int64(len(raw)-1)); err == nil {
		t.Fatal("dados incompletos aceitos")
	}
	raw[22] = 1
	if _, err := recordingForPlayback(bytes.NewReader(raw), int64(len(raw))); err == nil {
		t.Fatal("formato inesperado aceito")
	}
}
