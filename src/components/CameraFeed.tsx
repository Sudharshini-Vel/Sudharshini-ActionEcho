import { useRef, useEffect, useState } from "react";
import Webcam from "react-webcam";
import { 
  GestureRecognizer, 
  FaceLandmarker, 
  PoseLandmarker, 
  FilesetResolver, 
  DrawingUtils 
} from "@mediapipe/tasks-vision";
import { cn } from "../lib/utils";

interface CameraFeedProps {
  onGesture: (gesture: string, context?: string) => void;
  sensitivity: number;
  isCameraOn: boolean;
}

export default function CameraFeed({ onGesture, sensitivity, isCameraOn }: CameraFeedProps) {
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const [gestureRecognizer, setGestureRecognizer] = useState<GestureRecognizer | null>(null);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [poseLandmarker, setPoseLandmarker] = useState<PoseLandmarker | null>(null);
  
  const [lastGesture, setLastGesture] = useState<string>("");
  const [confidence, setConfidence] = useState<number>(0);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [expression, setExpression] = useState<string>("Neutral");
  const [fps, setFps] = useState<number>(0);

  // Optimization Refs
  const frameCountRef = useRef(0);
  const lastGestureTimeRef = useRef(0);
  const gestureHistoryRef = useRef<string[]>([]);
  const lastTimeRef = useRef(performance.now());

  useEffect(() => {
    const initMediaPipe = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
        );

        // Use lightweight configurations with staggered initialization to prevent GPU context issues
        const gesture = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1,
        });
        setGestureRecognizer(gesture);

        // Small delay to allow GPU context to stabilize
        await new Promise(resolve => setTimeout(resolve, 100));

        const face = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
          },
          outputFaceBlendshapes: true,
          runningMode: "VIDEO",
        });
        setFaceLandmarker(face);

        await new Promise(resolve => setTimeout(resolve, 100));

        const pose = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
        });
        setPoseLandmarker(pose);

      } catch (error) {
        console.error("Failed to initialize MediaPipe:", error);
      }
    };

    if (isCameraOn) {
      initMediaPipe();
    }
  }, [isCameraOn]);

  useEffect(() => {
    let animationFrameId: number;

    const predict = async () => {
      if (
        isCameraOn &&
        gestureRecognizer &&
        faceLandmarker &&
        poseLandmarker &&
        webcamRef.current &&
        webcamRef.current.video &&
        webcamRef.current.video.readyState === 4
      ) {
        const video = webcamRef.current.video;
        const nowInMs = Date.now();
        const frameIdx = frameCountRef.current++;

        // Calculate FPS
        const now = performance.now();
        const delta = now - lastTimeRef.current;
        if (delta >= 1000) {
          setFps(Math.round((frameCountRef.current * 1000) / delta));
          frameCountRef.current = 0;
          lastTimeRef.current = now;
        }

        // 1. Gesture Detection (Every Frame - High Priority)
        const gestureResults = gestureRecognizer.recognizeForVideo(video, nowInMs);
        
        // 2. Face Detection (Every 2nd Frame)
        let faceResults = null;
        if (frameIdx % 2 === 0) {
          faceResults = faceLandmarker.detectForVideo(video, nowInMs);
        }

        // 3. Pose Detection (Every 2nd Frame)
        let poseResults = null;
        if (frameIdx % 2 === 1) {
          poseResults = poseLandmarker.detectForVideo(video, nowInMs);
        }

        const canvasCtx = canvasRef.current?.getContext("2d");
        if (canvasCtx && canvasRef.current) {
          canvasCtx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          const drawingUtils = new DrawingUtils(canvasCtx);

          // Draw Pose
          if (poseResults?.landmarks) {
            for (const landmarks of poseResults.landmarks) {
              drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: "#1F6FEB", lineWidth: 2 });
              drawingUtils.drawLandmarks(landmarks, { color: "#E6EDF3", lineWidth: 1, radius: 2 });
            }
          }

          // Draw Face & Update Expression
          if (faceResults?.faceLandmarks) {
            for (const landmarks of faceResults.faceLandmarks) {
              drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LIPS, { color: "#E0E0E0", lineWidth: 1 });
              drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: "#E0E0E0", lineWidth: 1 });
            }

            if (faceResults.faceBlendshapes?.[0]) {
              const shapes = faceResults.faceBlendshapes[0].categories;
              const smile = shapes.find(s => s.categoryName === "mouthSmileLeft")?.score || 0;
              const browDown = shapes.find(s => s.categoryName === "browDownLeft")?.score || 0;
              if (smile > 0.5) setExpression("Happy");
              else if (browDown > 0.5) setExpression("Serious");
              else setExpression("Neutral");
            }
          }

          // Draw Hands & Process Gestures
          if (gestureResults.landmarks) {
            for (const landmarks of gestureResults.landmarks) {
              drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#1F6FEB", lineWidth: 4 });
              drawingUtils.drawLandmarks(landmarks, { color: "#FFFFFF", lineWidth: 1, radius: 3 });
            }
          }

          // SMART GESTURE PROCESSING (Smoothing + Debounce)
          if (gestureResults.gestures?.[0]) {
            const topGesture = gestureResults.gestures[0][0];
            const currentSensitivity = sensitivity > 0.5 ? 0.5 : sensitivity; // Cap sensitivity for reliability
            
            if (topGesture.score > currentSensitivity) {
              const gestureName = topGesture.categoryName;
              
              // Smoothing: Add to history
              gestureHistoryRef.current.push(gestureName);
              if (gestureHistoryRef.current.length > 3) gestureHistoryRef.current.shift(); // Smaller window for faster response

              // Voting: Only confirm if 2/3 frames agree
              const counts = gestureHistoryRef.current.reduce((acc, val) => {
                acc[val] = (acc[val] || 0) + 1;
                return acc;
              }, {} as Record<string, number>);

              const [mostFrequent] = (Object.entries(counts) as [string, number][]).sort((a, b) => b[1] - a[1])[0];
              
              if (counts[mostFrequent] >= 2 && mostFrequent !== "None") {
                const now = Date.now();
                // Cooldown: Prevent rapid firing (min 300ms between unique gestures)
                if (now - lastGestureTimeRef.current > 300 || mostFrequent !== lastGesture) {
                  console.log(`[DEBUG] Gesture Detected: ${mostFrequent} (Conf: ${topGesture.score.toFixed(2)})`);
                  setLastGesture(mostFrequent);
                  setConfidence(topGesture.score);
                  onGesture(mostFrequent, expression);
                  lastGestureTimeRef.current = now;
                }
              }
            }
          } else if (lastGesture) {
            // Fallback: Keep showing last gesture if it was recent
            if (Date.now() - lastGestureTimeRef.current < 1000) {
              // Keep state as is
            } else {
              // Clear after 1s of no detection
              // setLastGesture("");
            }
          }
        }
      }
      animationFrameId = requestAnimationFrame(predict);
    };

    predict();
    return () => cancelAnimationFrame(animationFrameId);
  }, [gestureRecognizer, faceLandmarker, poseLandmarker, isCameraOn, sensitivity, lastGesture, onGesture, expression]);

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
      {isCameraOn && !cameraError && (
        <>
          <Webcam
            ref={webcamRef}
            audio={false}
            className="absolute inset-0 w-full h-full object-cover mirror"
            videoConstraints={{
              width: 640, // Optimized resolution
              height: 480,
              facingMode: "user",
            }}
            onUserMediaError={(err) => setCameraError(err.toString())}
            mirrored={false}
            screenshotFormat="image/jpeg"
            disablePictureInPicture={true}
            forceScreenshotSourceSize={false}
            imageSmoothing={false} // Faster rendering
            onUserMedia={() => setCameraError(null)}
            screenshotQuality={0.92}
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full object-cover mirror pointer-events-none"
            width={640}
            height={480}
          />
          
          <div className="absolute top-6 right-6 flex flex-col gap-2 items-end">
            <div className="px-3 py-1 bg-black/60 backdrop-blur-md rounded-lg border border-white/10 text-[10px] font-mono uppercase tracking-widest">
              FPS: {fps}
            </div>
            <div className="px-3 py-1 bg-accent/20 backdrop-blur-md rounded-lg border border-accent/40 text-[10px] font-mono uppercase tracking-widest">
              Expression: {expression}
            </div>
            <div className="px-3 py-1 bg-accent/20 backdrop-blur-md rounded-lg border border-accent/40 text-[10px] font-mono uppercase tracking-widest">
              Confidence: {(confidence * 100).toFixed(1)}%
            </div>
          </div>
        </>
      )}
      
      {(cameraError || !isCameraOn) && (
        <div className="text-center space-y-4 p-6">
          <div className="w-20 h-20 bg-accent/10 rounded-full flex items-center justify-center mx-auto border border-accent/20">
            {cameraError ? (
              <div className="w-8 h-8 bg-red-500 rounded-full" />
            ) : (
              <div className="w-8 h-8 bg-accent rounded-full animate-pulse" />
            )}
          </div>
          <div className="space-y-2">
            <p className="text-muted font-medium">
              {cameraError ? "Camera Access Error" : "Camera is currently disabled"}
            </p>
            {cameraError && (
              <p className="text-xs text-red-400/60 max-w-xs mx-auto">
                {cameraError.includes("Requested device not found") 
                  ? "No camera device detected. Please ensure your webcam is connected."
                  : cameraError}
              </p>
            )}
          </div>
        </div>
      )}

      <style>{`
        .mirror {
          transform: scaleX(-1);
        }
      `}</style>
    </div>
  );
}
