// Infinity Timetable setup: downloads the Windows program from GitHub, unpacks it and starts it.
// The program then installs itself (asking first, or quietly when run as an update with --update).
// Old copies of Infinity Timetable (2.1 to 2.3) download and run this file to move to the new program.
package main

import (
	"archive/zip"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var Version = "dev" // set at build time
const repo = "infinitytimetable/infinite-timetable"

func zipURL() string {
	return "https://github.com/" + repo + "/releases/download/windows/InfinityTimetable-" + Version + "-Windows.zip"
}

func msg(text string, icon uint32) {
	u := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString("Infinity Timetable setup")
	u.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(icon))
}

func fail(text string) {
	fmt.Println("\n" + text)
	msg(text, 0x10)
	os.Exit(1)
}

type progress struct {
	total, done int64
	last        time.Time
}

func (p *progress) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if time.Since(p.last) > 300*time.Millisecond {
		p.last = time.Now()
		if p.total > 0 {
			fmt.Printf("\r  Downloading: %d%%  (%d of %d MB)   ", p.done*100/p.total, p.done>>20, p.total>>20)
		} else {
			fmt.Printf("\r  Downloading: %d MB   ", p.done>>20)
		}
	}
	return len(b), nil
}

func main() {
	update := false
	for _, a := range os.Args[1:] {
		if a == "--update" {
			update = true
		}
	}
	exec.Command("cmd", "/c", "title Infinity Timetable setup").Run()
	fmt.Println("Infinity Timetable " + Version + " setup")
	fmt.Println("=================================")
	fmt.Println("Getting the program from the internet (about 110 MB). Please wait...")

	work := filepath.Join(os.TempDir(), "InfinityTimetable-setup")
	os.RemoveAll(work)
	if err := os.MkdirAll(work, 0755); err != nil {
		fail("Could not make a folder for setup: " + err.Error())
	}
	zipPath := filepath.Join(work, "program.zip")
	c := &http.Client{Timeout: 30 * time.Minute}
	res, err := c.Get(zipURL())
	if err != nil {
		fail("Could not download Infinity Timetable. Check the internet connection and try again.\n\n" + err.Error())
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		fail(fmt.Sprintf("Could not download Infinity Timetable (the server answered %d). Try again later.", res.StatusCode))
	}
	f, err := os.Create(zipPath)
	if err != nil {
		fail("Could not save the download: " + err.Error())
	}
	n, err := io.Copy(io.MultiWriter(f, &progress{total: res.ContentLength}), res.Body)
	f.Close()
	if err != nil || n < 20<<20 {
		fail("The download was incomplete. Check the internet connection and try again.")
	}
	fmt.Println("\n  Unpacking...")
	exe, err := unzip(zipPath, work)
	if err != nil {
		fail("Could not unpack the program: " + err.Error())
	}
	os.Remove(zipPath)
	args := []string{}
	if update {
		args = append(args, "--update")
	}
	fmt.Println("  Starting Infinity Timetable...")
	if err := exec.Command(exe, args...).Start(); err != nil {
		fail("Could not start Infinity Timetable: " + err.Error())
	}
	time.Sleep(1500 * time.Millisecond)
}

func unzip(src, dst string) (string, error) {
	r, err := zip.OpenReader(src)
	if err != nil {
		return "", err
	}
	defer r.Close()
	exe := ""
	for _, z := range r.File {
		p := filepath.Join(dst, z.Name)
		if !strings.HasPrefix(p, filepath.Clean(dst)+string(os.PathSeparator)) {
			return "", fmt.Errorf("bad path in zip: %s", z.Name)
		}
		if z.FileInfo().IsDir() {
			os.MkdirAll(p, 0755)
			continue
		}
		os.MkdirAll(filepath.Dir(p), 0755)
		in, err := z.Open()
		if err != nil {
			return "", err
		}
		out, err := os.Create(p)
		if err != nil {
			in.Close()
			return "", err
		}
		_, err = io.Copy(out, in)
		in.Close()
		out.Close()
		if err != nil {
			return "", err
		}
		if strings.EqualFold(filepath.Base(p), "Infinity Timetable.exe") {
			exe = p
		}
	}
	if exe == "" {
		return "", fmt.Errorf("the program was not found in the download")
	}
	return exe, nil
}
